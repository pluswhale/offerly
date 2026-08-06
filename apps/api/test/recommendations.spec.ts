import { describe, expect, it, vi } from "vitest";
import type { Job, JobMatch } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { cvExtractV1 } from "../src/modules/ai/prompts/cv-extract.v1.js";
import { cvValidateV1 } from "../src/modules/ai/prompts/cv-validate.v1.js";
import {
  createRecommendationsTemplate,
  RECOMMENDATIONS_TEMPLATE_VERSION,
  type RecommendationsInput,
} from "../src/modules/ai/prompts/recommendations.v1.js";
import { buildPrompt, UNTRUSTED_DATA_RULE } from "../src/modules/ai/prompts/prompt.types.js";
import { normalizeForCache, sha256Hex } from "../src/modules/ai/text.js";
import { ProfilePipelineService } from "../src/modules/candidate-profiles/profile-pipeline.service.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import { JobProfileService } from "../src/modules/jobs/job-profile.service.js";
import { JobsService } from "../src/modules/jobs/jobs.service.js";
import { MatchService, type StoredMatchResultV2 } from "../src/modules/jobs/match.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import {
  CV_CONTENT_HASH,
  CV_TEXT,
  fixtureProfile,
} from "./fixtures/cv-profile.fixture.js";

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";

/** Same mock style as match.spec.ts: queued provider responses. */
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
 * Stateful Supabase mock (same pattern as match.spec.ts): real row storage
 * for cvs, jobs, candidate_profiles, job_profiles and job_matches. Seeded
 * profile + job profile keep every stage except match-requirements and
 * recommendations off the LLM.
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

  clock(): string {
    return new Date(1_700_000_000_000 + this.seq * 1000).toISOString();
  }
}

class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private mutation: { type: "insert" | "update" | "delete" | "upsert"; payload?: Row } | null = null;
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

  insert(payload: Row): this {
    this.mutation = { type: "insert", payload };
    return this;
  }

  upsert(payload: Row): this {
    this.mutation = { type: "upsert", payload };
    return this;
  }

  update(payload: Row): this {
    this.mutation = { type: "update", payload };
    return this;
  }

  delete(): this {
    this.mutation = { type: "delete" };
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
    } else if (mutation?.type === "upsert") {
      const payload = mutation.payload!;
      let row = this.table.rows.find((candidate) => candidate.job_id === payload.job_id);
      if (row) {
        Object.assign(row, payload);
      } else {
        row = {
          id: this.table.nextId(),
          created_at: this.table.clock(),
          ...payload,
        };
        this.table.rows.push(row);
      }
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

  then<T>(resolve: (value: { data: Row[]; error: null }) => T | PromiseLike<T>): Promise<T> {
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

const JD_TEXT =
  "Senior Backend Engineer at FinLane. Must have: TypeScript, Docker and containerized deployments. " +
  "We build payment infrastructure for the German market with a modern cloud stack.";

const jobContentHash = sha256Hex(normalizeForCache(JD_TEXT));

/**
 * The seeded candidate: the fixture profile plus one stated devops tool, so a
 * 'missing' Docker verdict cites positive coverage (skills.devops_tools[0]) —
 * never silence (spec §FR-7).
 */
function dockerLessProfile(): Row {
  const profile = fixtureProfile();
  profile.skills.devops_tools.push({
    value: "Kubernetes",
    status: "stated",
    confidence: 0.9,
    evidence: "Deployed services on Kubernetes",
  });
  return {
    id: "profile-1",
    user_id: USER,
    cv_id: CV_ID,
    version: 1,
    status: "ready",
    profile,
    stage_meta: {
      content_hash: CV_CONTENT_HASH,
      template_versions: {
        extract: cvExtractV1.templateVersion,
        validate: cvValidateV1.templateVersion,
      },
      stages: {},
    },
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
  };
}

const stated = (value: unknown, evidence: string) => ({
  value,
  status: "stated",
  confidence: 0.9,
  evidence,
});

const unknownLeaf = { value: null, status: "unknown", confidence: 0, evidence: null };

function jobProfileRow(): Row {
  return {
    id: "jp-1",
    job_id: JOB_ID,
    profile: {
      required_skills: [],
      preferred_skills: [],
      min_years_experience: unknownLeaf,
      industry: unknownLeaf,
      location: unknownLeaf,
      remote_policy: unknownLeaf,
      languages: [],
      education_requirements: [],
      requirements: [
        {
          id: "req-ts",
          text: stated("TypeScript", "Must have: TypeScript"),
          category: "skill",
          importance: "must_have",
        },
        {
          id: "req-docker",
          text: stated("Docker and containerized deployments", "Docker and containerized deployments"),
          category: "skill",
          importance: "must_have",
        },
      ],
    },
    template_version: "jd-extract.v1",
    content_hash: jobContentHash,
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

/** Recorded match-requirements.v1 verdict for the unresolved Docker requirement. */
const DOCKER_VERDICT_RESPONSE = {
  verdicts: [
    {
      requirement_id: "req-docker",
      verdict: "missing",
      confidence: 0.85,
      candidate_evidence: ["skills.devops_tools[0]"],
      reasoning:
        "The profile states devops tooling (Kubernetes at skills.devops_tools[0]) and Docker is not among them.",
    },
  ],
};

/**
 * Recorded recommendations.v1 output: grounded in the Docker verdict, with
 * one bogus ref the validator must strip (documented policy: refs are a
 * hint, never load-bearing).
 */
const DOCKER_RECOMMENDATIONS_RESPONSE = {
  recommendations: [
    {
      priority: 1,
      action:
        "Add Docker to your CV with a concrete deployment example — it is an explicit must-have you currently miss",
      rationale: "req-docker is a missing must-have: the profile covers devops tooling but not Docker.",
      requirement_refs: ["req-docker", "req-bogus"],
    },
    {
      priority: 2,
      action: "Lead with your TypeScript payment-API work — it directly matches a must-have",
      rationale: "req-ts is a matched must-have; surfacing it strengthens the application.",
      requirement_refs: ["req-ts"],
    },
  ],
};

interface Harness {
  service: MatchService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(provider: LlmProvider): Harness {
  const job: Job = {
    id: JOB_ID,
    user_id: USER,
    title: "Senior Backend Engineer",
    company: "FinLane GmbH",
    url: null,
    description_text: JD_TEXT,
    content_hash: jobContentHash,
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
  const client = new StatefulClient()
    .seed("cvs", [
      {
        id: CV_ID,
        user_id: USER,
        name: "Pasted CV",
        file_path: null,
        extracted_text: CV_TEXT,
        content_hash: CV_CONTENT_HASH,
        is_active: true,
        created_at: new Date(1_700_000_000_000).toISOString(),
      },
    ])
    .seed("jobs", [job as unknown as Row])
    .seed("candidate_profiles", [dockerLessProfile()])
    .seed("job_profiles", [jobProfileRow()]);

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
  const cvs = new CvsService(supabase);
  const pipeline = new ProfilePipelineService(supabase, ai, cvs);
  const jobProfiles = new JobProfileService(supabase, ai, jobs);
  return {
    service: new MatchService(supabase, jobs, cvs, ai, pipeline, jobProfiles),
    provider,
    client,
    usage,
  };
}

function reportOf(match: JobMatch): StoredMatchResultV2 {
  return match.result as StoredMatchResultV2;
}

describe("recommendations.v1 template (spec 003 §FR-10, T4.2)", () => {
  const template = createRecommendationsTemplate({ requirementIds: ["req-docker", "req-ts"] });
  const input: RecommendationsInput = {
    report: {
      version: 2,
      score: 40,
      weights_version: "weights.v1",
      breakdown: {} as StoredMatchResultV2["breakdown"],
      verdicts: [],
      low_confidence: false,
      unknown_must_have_share: 0,
      template_versions: {},
    },
    profileContentHash: "p-hash",
    jobContentHash: "j-hash",
  };

  it("builds a guarded prompt carrying the report JSON as untrusted data", () => {
    const prompt = buildPrompt(template, input);
    expect(prompt.templateVersion).toBe(RECOMMENDATIONS_TEMPLATE_VERSION);
    expect(prompt.messages[0]?.content).toContain(UNTRUSTED_DATA_RULE);
    expect(prompt.messages[1]?.content).toContain("<match_report>");
  });

  it("cache identity = profile content hash + job content hash + weights version", () => {
    expect(template.cacheInput(input)).toBe("p-hash:j-hash:weights.v1");
  });

  it("validate enforces 2-4 recommendations", () => {
    const item = { priority: 1, action: "Do X", rationale: "Because Y", requirement_refs: [] };
    expect(template.validate({ recommendations: [item] })).toBeNull();
    expect(
      template.validate({ recommendations: [item, item, item, item, item] }),
    ).toBeNull();
    expect(template.validate({ recommendations: [item, item] })).not.toBeNull();
  });

  it("validate strips requirement_refs that are not in the report", () => {
    const validated = template.validate({
      recommendations: [
        { priority: 1, action: "Do X", rationale: "R", requirement_refs: ["req-docker", "req-nope"] },
        { priority: 2, action: "Do Y", rationale: "R" },
      ],
    });
    expect(validated?.recommendations[0]?.requirement_refs).toEqual(["req-docker"]);
    expect(validated?.recommendations[1]?.requirement_refs).toEqual([]); // omitted → default
  });
});

describe("recommendations in the match flow (spec 003 §FR-10, T4.2)", () => {
  it("recommendations are grounded in the actual verdicts: missing Docker must-have → Docker action", async () => {
    const provider = makeProvider([
      JSON.stringify(DOCKER_VERDICT_RESPONSE),
      JSON.stringify(DOCKER_RECOMMENDATIONS_RESPONSE),
    ]);
    const { service, usage } = makeHarness(provider);

    const match = await service.match(USER, TOKEN, JOB_ID);
    const report = reportOf(match);

    // Two LLM calls only: match-requirements (Docker unresolved) + recommendations.
    expect(provider.complete).toHaveBeenCalledTimes(2);

    // The missing Docker must-have drives the top recommendation.
    expect(report.verdicts.find((v) => v.requirement_id === "req-docker")?.verdict).toBe("missing");
    expect(report.recommendations).toHaveLength(2);
    expect(report.recommendations?.[0]?.priority).toBe(1);
    expect(report.recommendations?.[0]?.action).toContain("Docker");
    expect(report.recommendations?.[0]?.rationale).toContain("req-docker");
    // The bogus ref was stripped; real refs survive.
    expect(report.recommendations?.[0]?.requirement_refs).toEqual(["req-docker"]);
    expect(report.recommendations?.[1]?.requirement_refs).toEqual(["req-ts"]);

    // The recommendations call received the actual report (grounded input).
    const calls = vi.mocked(provider.complete).mock.calls;
    const recsUser = calls[1]?.[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(recsUser).toContain("req-docker");
    expect(recsUser).toContain('"missing"');

    // Usage: the recommendations call IS the quota-counting job_match row
    // (real tokens roll up on the gateway call — exactly one such row).
    expect(usage.map((row) => row.operation)).toEqual(["match_requirements", "job_match"]);
    expect(usage[1]).toMatchObject({
      operation: "job_match",
      tokens_in: 100,
      tokens_out: 50,
      cache_hit: false,
    });
  });

  it("repeat POST reuses the stored report — zero LLM calls including recommendations", async () => {
    const provider = makeProvider([
      JSON.stringify(DOCKER_VERDICT_RESPONSE),
      JSON.stringify(DOCKER_RECOMMENDATIONS_RESPONSE),
    ]);
    const { service, client, usage } = makeHarness(provider);

    const first = await service.match(USER, TOKEN, JOB_ID);
    const second = await service.match(USER, TOKEN, JOB_ID);

    expect(provider.complete).toHaveBeenCalledTimes(2); // no new calls
    expect(client.table("job_matches").rows).toHaveLength(1);
    expect(usage).toHaveLength(2); // quota not double-charged
    expect(second.id).toBe(first.id);
    expect(reportOf(second).recommendations).toEqual(reportOf(first).recommendations);
  });

  it("recommendations failure degrades the report instead of failing the match (quota row still recorded once)", async () => {
    const provider = makeProvider([
      JSON.stringify(DOCKER_VERDICT_RESPONSE),
      new Error("provider boom"),
    ]);
    const { service, usage } = makeHarness(provider);

    const match = await service.match(USER, TOKEN, JOB_ID);
    const report = reportOf(match);

    expect(report.version).toBe(2);
    expect(report.recommendations).toBeUndefined();
    // The zero-token quota row replaced the failed gateway call's row.
    expect(usage.map((row) => row.operation)).toEqual(["match_requirements", "job_match"]);
    expect(usage[1]).toMatchObject({ operation: "job_match", tokens_in: 0, cache_hit: false });
  });
});
