import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { extractJobProfile } from "../src/modules/ai/job-extraction.js";
import { jdExtractV1 } from "../src/modules/ai/prompts/jd-extract.v1.js";
import { buildPrompt } from "../src/modules/ai/prompts/prompt.types.js";
import { jobProfileSchema } from "../src/modules/ai/schemas/job-profile.schema.js";
import { normalizeForCache, sha256Hex } from "../src/modules/ai/text.js";
import { JobProfileService } from "../src/modules/jobs/job-profile.service.js";
import { JobsService } from "../src/modules/jobs/jobs.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { loadJdFixtures, type JdFixture } from "../scripts/ai-benchmark/dataset.js";
import {
  FINTECH_EXTRACT_RESPONSE,
  VAGUE_EXTRACT_RESPONSE,
  fixtureJobProfile,
} from "./fixtures/jd-profile.fixture.js";

const USER_A = "user-a";
const USER_B = "user-b";
const TOKEN = "token";
const JOB_A = "job-aaaa";
const JOB_B = "job-bbbb";

let fintechJd: JdFixture;
let vagueJd: JdFixture;

beforeAll(async () => {
  const jds = await loadJdFixtures();
  const byName = new Map(jds.map((jd) => [jd.name, jd]));
  fintechJd = byName.get("senior-backend-fintech")!;
  vagueJd = byName.get("vague-rockstar")!;
});

/** Same mock style as cv-extract.spec.ts: queued provider responses. */
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

/**
 * Minimal stateful Supabase mock (same idea as candidate-profiles.spec.ts):
 * real row storage so row reuse, upsert-on-stale-hash and per-user rows can
 * be asserted. Supports exactly the query shapes JobProfileService/JobsService
 * use. Mutations are lazy: supabase applies .eq() filters chained AFTER
 * update/upsert, so execution defers to the terminal call.
 */
type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[];
  private seq = 0;

  constructor(seed: Row[] = []) {
    this.rows = seed.map((row) => ({ ...row }));
  }

  nextId(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  }
}

class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private mutation: { payload: Row; upsert: boolean } | null = null;
  private affected: Row[] | null = null;

  constructor(private readonly table: FakeTable) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  insert(payload: Row): this {
    this.mutation = { payload, upsert: false };
    return this;
  }

  upsert(payload: Row): this {
    this.mutation = { payload, upsert: true };
    return this;
  }

  private finalize(): Row[] {
    if (!this.affected) {
      if (this.mutation) {
        const payload = this.mutation.payload;
        let row = this.mutation.upsert
          ? this.table.rows.find((candidate) => candidate.job_id === payload.job_id)
          : undefined;
        if (row) {
          Object.assign(row, payload);
        } else {
          row = {
            id: this.table.nextId(),
            created_at: new Date(1_700_000_000_000).toISOString(),
            ...payload,
          };
          this.table.rows.push(row);
        }
        this.affected = [row];
      } else {
        this.affected = this.table.rows.filter((row) => this.filters.every((f) => f(row)));
      }
    }
    return this.affected;
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.finalize()[0] ?? null, error: null });
  }

  single(): Promise<{ data: Row | null; error: null }> {
    return this.maybeSingle();
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

function seedJob(id: string, userId: string, jdText: string): Job {
  return {
    id,
    user_id: userId,
    title: "Senior Backend Engineer",
    company: "FinLane GmbH",
    url: null,
    description_text: jdText,
    content_hash: sha256Hex(normalizeForCache(jdText)),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

interface Harness {
  service: JobProfileService;
  ai: AiService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(provider: LlmProvider, jobsSeed: Job[], profilesSeed: Row[] = []): Harness {
  const client = new StatefulClient()
    .seed("jobs", jobsSeed as unknown as Row[])
    .seed("job_profiles", profilesSeed);

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
  const jobs = new JobsService(supabase);
  return { service: new JobProfileService(supabase, ai, jobs), ai, provider, client, usage };
}

describe("jd-extract.v1 template (spec 003 §FR-5/§FR-10, T3.1)", () => {
  it("cacheInput is the job content hash, not the text", () => {
    const prompt = buildPrompt(jdExtractV1, {
      jdText: fintechJd.jdText,
      contentHash: "hash-1",
      truncated: false,
    });
    expect(prompt.cacheInput).toBe("hash-1");
    const other = buildPrompt(jdExtractV1, {
      jdText: "totally different text",
      contentHash: "hash-1",
      truncated: false,
    });
    expect(other.cacheInput).toBe(prompt.cacheInput);
  });

  it("wraps the JD as untrusted data and keeps the injection rule", () => {
    const prompt = buildPrompt(jdExtractV1, {
      jdText: fintechJd.jdText,
      contentHash: "hash-1",
      truncated: false,
    });
    expect(prompt.templateVersion).toBe("jd-extract.v1");
    expect(jdExtractV1.modelTier).toBe("cheap");
    expect(prompt.messages[0]?.content).toContain("untrusted user-provided data");
    expect(prompt.messages[0]?.content).toContain("VERBATIM");
    expect(prompt.messages[0]?.content).not.toContain(fintechJd.jdText);
    expect(prompt.messages[1]?.content).toBe(`<job_description>\n${fintechJd.jdText}\n</job_description>`);
  });

  it("discloses truncation in the user message", () => {
    const prompt = buildPrompt(jdExtractV1, {
      jdText: "short text",
      contentHash: "h",
      truncated: true,
    });
    expect(prompt.messages[1]?.content).toContain("truncated");
  });

  it("validate parses both recorded fixture responses", () => {
    expect(jdExtractV1.validate(structuredClone(FINTECH_EXTRACT_RESPONSE))).not.toBeNull();
    expect(jdExtractV1.validate(structuredClone(VAGUE_EXTRACT_RESPONSE))).not.toBeNull();
  });

  it("validate rejects an omitted field and a stated item without evidence", () => {
    const broken = structuredClone(FINTECH_EXTRACT_RESPONSE) as Record<string, unknown>;
    delete broken.remote_policy;
    expect(jdExtractV1.validate(broken)).toBeNull();

    const noEvidence = fixtureJobProfile();
    noEvidence.requirements[0]!.text.evidence = null;
    expect(jdExtractV1.validate(noEvidence)).toBeNull();
  });
});

describe("extractJobProfile (T3.1)", () => {
  it("fintech fixture: required skills match expected.json, usage op jd_extract", async () => {
    const provider = makeProvider([JSON.stringify(FINTECH_EXTRACT_RESPONSE)]);
    const { ai, usage } = makeHarness(provider, []);

    const result = await extractJobProfile(ai, {
      userId: USER_A,
      jdText: fintechJd.jdText,
      contentHash: "hash-fintech",
    });

    const expected = fintechJd.expectation.expected;
    const required = result.profile.required_skills.map((skill) => skill.value);
    expect([...required].sort()).toEqual([...expected.required_skills].sort());
    const preferred = result.profile.preferred_skills.map((skill) => skill.value);
    expect([...preferred].sort()).toEqual([...expected.preferred_skills].sort());
    expect(result.profile.min_years_experience.value).toBe(expected.min_years_experience);
    expect(result.profile.remote_policy.value).toBe(expected.remote_policy);
    expect(result.profile.industry.value).toBe(expected.industry);
    expect(result.profile.languages.map((lang) => lang.value)).toEqual(expected.languages);
    // Every must_have/nice_to_have requirement's text verified verbatim (AC-1).
    expect(result.report.flagged).toEqual([]);
    expect(result.report.verifiedCount).toBe(result.report.totalCount);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage[0]).toMatchObject({ operation: "jd_extract", cache_hit: false });
  });

  it("vague fixture: schema-valid profile with remote_policy 'unknown', nothing invented", async () => {
    const provider = makeProvider([JSON.stringify(VAGUE_EXTRACT_RESPONSE)]);
    const { ai } = makeHarness(provider, []);

    const result = await extractJobProfile(ai, {
      userId: USER_A,
      jdText: vagueJd.jdText,
      contentHash: "hash-vague",
    });

    expect(jobProfileSchema.safeParse(result.profile).success).toBe(true);
    const expected = vagueJd.expectation.expected;
    expect(result.profile.required_skills).toEqual([]);
    expect(result.profile.preferred_skills).toEqual([]);
    expect(result.profile.requirements).toEqual([]);
    expect(result.profile.min_years_experience).toMatchObject({
      value: expected.min_years_experience,
      status: "unknown",
    });
    expect(result.profile.remote_policy).toMatchObject({ value: null, status: "unknown" });
    expect(result.profile.industry).toMatchObject({ value: null, status: "unknown" });
    expect(result.profile.languages).toEqual([]);
  });

  it("a fabricated requirement quote is flagged and clamped by the verifier", async () => {
    const fabricated = fixtureJobProfile();
    fabricated.requirements.push({
      id: "req-99",
      text: {
        value: "deep GraphQL and gRPC expertise",
        status: "stated",
        confidence: 0.95,
        evidence: "deep GraphQL and gRPC expertise",
      },
      category: "skill",
      importance: "nice_to_have",
    });
    const provider = makeProvider([JSON.stringify(fabricated)]);
    const { ai } = makeHarness(provider, []);

    const result = await extractJobProfile(ai, {
      userId: USER_A,
      jdText: fintechJd.jdText,
      contentHash: "hash-fintech",
    });

    expect(result.report.flagged).toHaveLength(1);
    expect(result.report.flagged[0]).toMatchObject({
      path: "requirements[9].text",
      flag: "evidence_unverified",
      value: "deep GraphQL and gRPC expertise",
    });
    expect(result.profile.requirements[9]?.text.confidence).toBeLessThanOrEqual(0.4);
  });
});

describe("JobProfileService (spec 003 §FR-5, T3.1)", () => {
  it("persists the profile with content hash + template version; second call reuses the row with zero LLM calls", async () => {
    const provider = makeProvider([JSON.stringify(FINTECH_EXTRACT_RESPONSE)]);
    const job = seedJob(JOB_A, USER_A, fintechJd.jdText);
    const { service, client, usage } = makeHarness(provider, [job]);

    const first = await service.getOrExtract(USER_A, TOKEN, JOB_A);
    expect(first.reused).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(first.row.job_id).toBe(JOB_A);
    expect(first.row.content_hash).toBe(job.content_hash);
    expect(first.row.template_version).toBe("jd-extract.v1");
    expect(first.profile.required_skills.map((skill) => skill.value)).toContain("PostgreSQL");

    const second = await service.getOrExtract(USER_A, TOKEN, JOB_A);
    expect(second.reused).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    // The row-reuse path never reaches the gateway, so no usage record either.
    expect(usage).toHaveLength(1);
    expect(client.table("job_profiles").rows).toHaveLength(1);
  });

  it("same JD text matched by two users triggers one LLM call total (global cache, per-user rows)", async () => {
    const provider = makeProvider([JSON.stringify(FINTECH_EXTRACT_RESPONSE)]);
    const { service, client, usage } = makeHarness(provider, [
      seedJob(JOB_A, USER_A, fintechJd.jdText),
      seedJob(JOB_B, USER_B, fintechJd.jdText),
    ]);

    await service.getOrExtract(USER_A, TOKEN, JOB_A);
    const second = await service.getOrExtract(USER_B, TOKEN, JOB_B);

    // User B gets their own job_profiles row — but the identical JD text hits
    // the global llm_cache, so the provider was called exactly once.
    expect(second.reused).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(client.table("job_profiles").rows).toHaveLength(2);
    const userBUsage = usage.filter((row) => row.user_id === USER_B);
    expect(userBUsage).toHaveLength(1);
    expect(userBUsage[0]).toMatchObject({
      operation: "jd_extract",
      cache_hit: true,
      tokens_in: 0,
      tokens_out: 0,
    });
  });

  it("re-extracts when the stored row's content hash is stale", async () => {
    const provider = makeProvider([JSON.stringify(FINTECH_EXTRACT_RESPONSE)]);
    const job = seedJob(JOB_A, USER_A, fintechJd.jdText);
    const { service, client } = makeHarness(provider, [job], [
      {
        id: "stale-row",
        job_id: JOB_A,
        profile: VAGUE_EXTRACT_RESPONSE,
        template_version: "jd-extract.v1",
        content_hash: "old-hash-from-previous-text",
        created_at: new Date(1_700_000_000_000).toISOString(),
      },
    ]);

    const result = await service.getOrExtract(USER_A, TOKEN, JOB_A);

    expect(result.reused).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const rows = client.table("job_profiles").rows;
    expect(rows).toHaveLength(1); // upserted in place, not duplicated
    expect(rows[0]).toMatchObject({
      id: "stale-row",
      content_hash: job.content_hash,
      template_version: "jd-extract.v1",
    });
    expect(result.profile.required_skills.map((skill) => skill.value)).toContain("PostgreSQL");
  });

  it("computes the content hash for legacy jobs rows without one", async () => {
    const provider = makeProvider([JSON.stringify(FINTECH_EXTRACT_RESPONSE)]);
    const job = { ...seedJob(JOB_A, USER_A, fintechJd.jdText), content_hash: null };
    const { service } = makeHarness(provider, [job]);

    const result = await service.getOrExtract(USER_A, TOKEN, JOB_A);
    expect(result.row.content_hash).toBe(sha256Hex(normalizeForCache(fintechJd.jdText)));
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
