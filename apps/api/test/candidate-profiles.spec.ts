import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CandidateProfileRow, Cv } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { ProfilePipelineService } from "../src/modules/candidate-profiles/profile-pipeline.service.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import {
  CV_CONTENT_HASH,
  CV_EXTRACT_RESPONSE,
  CV_TEXT,
} from "./fixtures/cv-profile.fixture.js";

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Minimal stateful Supabase mock for the pipeline tests: real row storage per
 * table so status transitions, stage_meta and deletions can be asserted.
 * Supports exactly the query shapes ProfilePipelineService/CvsService use.
 */
type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[];
  readonly calls: Array<{ method: string; payload: unknown }> = [];
  private seq = 0;

  constructor(seed: Row[] = []) {
    this.rows = seed.map((row) => ({ ...row }));
  }

  nextId(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  }

  clock(): string {
    return new Date(1_700_000_000_000 + this.seq * 1000).toISOString();
  }
}

class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private mutation: { type: "insert" | "update" | "delete"; payload?: Row } | null = null;
  private affected: Row[] | null = null;

  constructor(private readonly table: FakeTable) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] !== val);
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  // Mutations are lazy: supabase applies the .eq() filters chained AFTER
  // update()/delete(), so execution defers to the terminal call.
  insert(payload: Row): this {
    this.mutation = { type: "insert", payload };
    this.table.calls.push({ method: "insert", payload });
    return this;
  }

  update(payload: Row): this {
    this.mutation = { type: "update", payload };
    this.table.calls.push({ method: "update", payload });
    return this;
  }

  delete(): this {
    this.mutation = { type: "delete" };
    this.table.calls.push({ method: "delete", payload: null });
    return this;
  }

  private finalize(): Row[] {
    if (this.affected) return this.affected;
    const mutation = this.mutation;
    if (mutation?.type === "insert") {
      const row = {
        id: this.table.nextId(),
        created_at: this.table.clock(),
        updated_at: this.table.clock(),
        ...mutation.payload,
      };
      this.table.rows.push(row);
      this.affected = [row];
    } else if (mutation?.type === "update") {
      const rows = this.matchRows();
      for (const row of rows) Object.assign(row, mutation.payload);
      this.affected = rows;
    } else if (mutation?.type === "delete") {
      const doomed = new Set(this.matchRows());
      this.table.rows = this.table.rows.filter((row) => !doomed.has(row));
      this.affected = [...doomed];
    } else {
      this.affected = this.matchRows();
    }
    return this.affected;
  }

  private matchRows(): Row[] {
    let rows = this.table.rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAsc ? 1 : -1;
      rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * dir);
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.finalize()[0] ?? null, error: null });
  }

  single(): Promise<{ data: Row | null; error: null }> {
    return this.maybeSingle();
  }

  then<T>(
    resolve: (value: { data: Row[]; error: null }) => T | PromiseLike<T>,
  ): Promise<T> {
    return Promise.resolve({ data: this.finalize(), error: null }).then(resolve);
  }
}

class StatefulClient {
  private readonly tables = new Map<string, FakeTable>();

  table(name: string): FakeTable {
    let table = this.tables.get(name);
    if (!table) {
      table = new FakeTable();
      this.tables.set(name, table);
    }
    return table;
  }

  seed(name: string, rows: Row[]): this {
    this.tables.set(name, new FakeTable(rows));
    return this;
  }

  from(name: string): FakeQuery {
    return new FakeQuery(this.table(name));
  }
}

function makeProvider(responses: Array<string | Error>): LlmProvider {
  const queue = [...responses];
  return {
    complete: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { content: next ?? "", tokensIn: 100, tokensOut: 50 };
    }),
    stream: vi.fn(),
  };
}

interface Harness {
  service: ProfilePipelineService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(provider: LlmProvider, cvOverrides: Partial<Cv> = {}): Harness {
  const client = new StatefulClient().seed("cvs", [
    {
      id: CV_ID,
      user_id: USER,
      name: "Pasted CV",
      file_path: null,
      extracted_text: CV_TEXT,
      content_hash: CV_CONTENT_HASH,
      is_active: true,
      created_at: new Date(1_700_000_000_000).toISOString(),
      ...cvOverrides,
    },
  ]);

  // Service-role side of AiService: in-memory llm_cache + usage_records.
  const cache = new Map<string, unknown>();
  const usage: Array<Record<string, unknown>> = [];
  const serviceClient = {
    from(table: string) {
      if (table === "llm_cache") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({
                data: cache.has(key) ? { response: cache.get(key) } : null,
                error: null,
              }),
            }),
          }),
          upsert: async (row: { cache_key: string; response: unknown }) => {
            cache.set(row.cache_key, row.response);
            return { error: null };
          },
        };
      }
      if (table === "usage_records") {
        return {
          insert: async (row: Record<string, unknown>) => {
            usage.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  const supabase = {
    forUser: () => client,
    getServiceClient: () => serviceClient,
  } as unknown as SupabaseService;
  const ai = new AiService(supabase, provider);
  const cvs = new CvsService(supabase);
  return { service: new ProfilePipelineService(supabase, ai, cvs), provider, client, usage };
}

function readyRows(client: StatefulClient): CandidateProfileRow[] {
  return client
    .table("candidate_profiles")
    .rows.filter((row) => row.status === "ready") as unknown as CandidateProfileRow[];
}

describe("ProfilePipelineService (spec 003 §FR-1/§FR-3, T2.4)", () => {
  it("happy path: persists a ready profile with per-stage meta, S3 skipped", async () => {
    const { service, provider, client, usage } = makeHarness(
      makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]),
    );

    const started = await service.start(USER, TOKEN, CV_ID);
    expect(started.reused).toBe(false);
    expect(started.row.status).toBe("extracting");
    await started.done;

    const rows = readyRows(client);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.version).toBe(1);
    const meta = row.stage_meta as {
      content_hash: string;
      failed_stage?: string;
      stages: Record<string, Record<string, unknown>>;
    };
    expect(meta.content_hash).toBe(CV_CONTENT_HASH);
    expect(meta.stages.s1).toMatchObject({ template_version: "cv-extract.v1" });
    expect(meta.stages.s2).toMatchObject({ total: expect.any(Number), flagged: 0 });
    expect(meta.stages.s3).toMatchObject({ skipped: true, adjudicated: 0 });
    expect(meta.failed_stage).toBeUndefined();

    const profile = row.profile as { summary_quality?: number; headline: { title: { value: string } } };
    expect(profile.headline.title.value).toBe("Senior Backend Engineer");
    expect(profile.summary_quality).toEqual(expect.any(Number));

    // Zero flags → S3 never called the LLM (one call = S1 only).
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ operation: "cv_profile", cache_hit: false });
  });

  it("idempotent second POST: returns the ready profile with zero LLM calls", async () => {
    const { service, provider, usage } = makeHarness(
      makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]),
    );
    const first = await service.start(USER, TOKEN, CV_ID);
    await first.done;

    const second = await service.start(USER, TOKEN, CV_ID);
    expect(second.reused).toBe(true);
    expect(second.row.status).toBe("ready");
    expect(second.row.id).toBe(first.row.id);
    expect(provider.complete).toHaveBeenCalledTimes(1); // no new calls
    expect(usage).toHaveLength(1); // no new usage records
  });

  it("forced S3 failure → status failed; retry resumes at S3 without a second S1 usage record", async () => {
    // Planted fabrication: S2 flags it → S3 runs and fails.
    const fabricated = JSON.parse(JSON.stringify(CV_EXTRACT_RESPONSE)) as {
      skills: { devops_tools: Array<Record<string, unknown>> };
    };
    fabricated.skills.devops_tools.push({
      value: "Kubernetes",
      status: "stated",
      confidence: 0.95,
      evidence: "deployed Kubernetes clusters to AWS",
    });
    const provider = makeProvider([
      JSON.stringify(fabricated),
      new Error("provider boom"), // S3 attempt 1
      JSON.stringify({
        adjudications: [
          {
            path: "skills.devops_tools[0]",
            action: "drop",
            reason: "The excerpt never mentions Kubernetes.",
          },
        ],
      }), // S3 attempt 2 (retry)
    ]);
    const { service, client, usage } = makeHarness(provider);

    const first = await service.start(USER, TOKEN, CV_ID);
    await first.done;

    let row = client.table("candidate_profiles").rows[0] as unknown as CandidateProfileRow;
    expect(row.status).toBe("failed");
    const failedMeta = row.stage_meta as { failed_stage?: string; failure_reason?: string };
    expect(failedMeta.failed_stage).toBe("validating");
    expect(failedMeta.failure_reason).toBeTruthy();
    // S1 ran once; the failed S3 call recorded no usage (usage is logged on success).
    expect(usage).toHaveLength(1);
    expect(provider.complete).toHaveBeenCalledTimes(2);

    // Retry: resumes at 'validating' — S1 is NOT re-run.
    const retry = await service.start(USER, TOKEN, CV_ID);
    expect(retry.reused).toBe(false);
    expect(retry.row.id).toBe(row.id);
    await retry.done;

    row = client.table("candidate_profiles").rows[0] as unknown as CandidateProfileRow;
    expect(row.status).toBe("ready");
    const meta = row.stage_meta as { failed_stage?: string; stages: Record<string, unknown> };
    expect(meta.failed_stage).toBeUndefined();
    expect(meta.stages.s1).toBeDefined(); // from the first run
    // Exactly one more LLM call (S3) and one more usage record — no second S1.
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(usage).toHaveLength(2);
    const profile = row.profile as { skills: { devops_tools: unknown[] } };
    expect(profile.skills.devops_tools).toEqual([]); // fabrication dropped by S3
  });

  it("re-run on changed CV content preserves user corrections (spec AC-8, T2.5)", async () => {
    const { service, client } = makeHarness(
      makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]),
    );
    const first = await service.start(USER, TOKEN, CV_ID);
    await first.done;

    // User corrects total years on the ready profile.
    const corrected = await service.correct(
      USER,
      TOKEN,
      CV_ID,
      "headline.total_years_experience",
      12,
    );
    const correctedProfile = corrected.profile as {
      headline: { total_years_experience: Record<string, unknown> };
    };
    expect(correctedProfile.headline.total_years_experience).toMatchObject({
      value: 12,
      status: "stated",
      confidence: 1,
      evidence: null,
      source: "user",
    });

    // CV content changes → fresh pipeline run (new version, new row).
    const cvRow = client.table("cvs").rows[0]!;
    cvRow.content_hash = "hash-v2";
    const second = await service.start(USER, TOKEN, CV_ID);
    expect(second.reused).toBe(false);
    expect(second.row.version).toBe(2);
    await second.done;

    const rows = readyRows(client);
    expect(rows).toHaveLength(1); // old ready row superseded
    const profile = rows[0]!.profile as {
      headline: { total_years_experience: Record<string, unknown> };
    };
    expect(profile.headline.total_years_experience).toMatchObject({
      value: 12,
      source: "user",
    });
    const meta = rows[0]!.stage_meta as { user_fields_preserved?: number };
    expect(meta.user_fields_preserved).toBe(1);
  });

  it("PATCH rejects an unknown profile path with 400", async () => {
    const { service } = makeHarness(makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]));
    const started = await service.start(USER, TOKEN, CV_ID);
    await started.done;

    await expect(
      service.correct(USER, TOKEN, CV_ID, "skills.databases[0]", "Postgres"),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.correct(USER, TOKEN, CV_ID, "nonsense", 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("GET latest returns the newest profile row with stage meta", async () => {
    const { service } = makeHarness(makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]));
    const started = await service.start(USER, TOKEN, CV_ID);
    await started.done;

    const latest = await service.getLatest(USER, TOKEN, CV_ID);
    expect(latest.status).toBe("ready");
    expect(latest.stage_meta).toBeTruthy();
  });
});
