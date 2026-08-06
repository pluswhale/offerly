import { ServiceUnavailableException } from "@nestjs/common";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Job, JobMatch } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { cvExtractV1 } from "../src/modules/ai/prompts/cv-extract.v1.js";
import { cvValidateV1 } from "../src/modules/ai/prompts/cv-validate.v1.js";
import { normalizeForCache, sha256Hex } from "../src/modules/ai/text.js";
import {
  emptyCandidateProfile,
  ProfilePipelineService,
} from "../src/modules/candidate-profiles/profile-pipeline.service.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import { JobProfileService } from "../src/modules/jobs/job-profile.service.js";
import { JobsService } from "../src/modules/jobs/jobs.service.js";
import { MatchService, type StoredMatchResultV2 } from "../src/modules/jobs/match.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { loadJdFixtures, type JdFixture } from "../scripts/ai-benchmark/dataset.js";
import { CV_CONTENT_HASH, CV_EXTRACT_RESPONSE, CV_TEXT } from "./fixtures/cv-profile.fixture.js";
import { FINTECH_EXTRACT_RESPONSE, VAGUE_EXTRACT_RESPONSE } from "./fixtures/jd-profile.fixture.js";

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";

let fintechJd: JdFixture;

beforeAll(async () => {
  const jds = await loadJdFixtures();
  fintechJd = jds.find((jd) => jd.name === "senior-backend-fintech")!;
});

/** Same mock style as candidate-profiles.spec.ts: queued provider responses. */
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
 * Stateful Supabase mock merging the candidate-profiles.spec.ts and
 * job-profiles.spec.ts fakes: real row storage for cvs, jobs,
 * candidate_profiles, job_profiles and job_matches so pipeline inline-runs,
 * row reuse and report persistence can be asserted. Supports exactly the
 * query shapes MatchService and its collaborators use.
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

  // Mutations are lazy: supabase applies the .eq() filters chained AFTER
  // update/upsert, so execution defers to the terminal call.
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

interface Harness {
  service: MatchService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(
  provider: LlmProvider,
  seeds: { jobs?: Job[]; candidateProfiles?: Row[]; jobProfiles?: Row[]; jobMatches?: Row[] } = {},
): Harness {
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
    .seed("jobs", (seeds.jobs ?? []) as unknown as Row[])
    .seed("candidate_profiles", seeds.candidateProfiles ?? [])
    .seed("job_profiles", seeds.jobProfiles ?? [])
    .seed("job_matches", seeds.jobMatches ?? []);

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

function seedJob(id: string, jdText: string): Job {
  return {
    id,
    user_id: USER,
    title: "Senior Backend Engineer",
    company: "FinLane GmbH",
    url: null,
    description_text: jdText,
    content_hash: sha256Hex(normalizeForCache(jdText)),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

/**
 * Recorded match-requirements.v1 output for the fintech fixture: the pre-pass
 * resolves req-1 (years), req-2 (TypeScript), req-6 (English) and req-9
 * (German); the rest reach the LLM, and the honest verdict for all of them is
 * 'unknown' — the fixture CV is silent on databases, cloud, Docker, industries
 * and Kubernetes (spec AC-2 semantics).
 */
const FINTECH_VERDICTS_RESPONSE = {
  verdicts: [
    {
      requirement_id: "req-3",
      verdict: "unknown",
      confidence: 0.9,
      candidate_evidence: [],
      reasoning: "The profile is silent on databases — no PostgreSQL or Redis entry exists.",
    },
    {
      requirement_id: "req-4",
      verdict: "unknown",
      confidence: 0.9,
      candidate_evidence: [],
      reasoning: "The profile lists no cloud platforms, so AWS is unaddressed.",
    },
    {
      requirement_id: "req-5",
      verdict: "unknown",
      confidence: 0.9,
      candidate_evidence: [],
      reasoning: "The profile is silent on Docker and CI/CD tooling.",
    },
    {
      requirement_id: "req-7",
      verdict: "unknown",
      confidence: 0.9,
      candidate_evidence: [],
      reasoning: "The profile lists no industries, so fintech experience is unknown.",
    },
    {
      requirement_id: "req-8",
      verdict: "unknown",
      confidence: 0.9,
      candidate_evidence: [],
      reasoning: "The profile is silent on Kubernetes.",
    },
  ],
};

/**
 * Recorded recommendations.v1 output for the fintech report (T4.2): grounded
 * in the actual verdicts — the low-confidence profile completion leads, the
 * Docker must-have gap follows.
 */
const FINTECH_RECOMMENDATIONS_RESPONSE = {
  recommendations: [
    {
      priority: 1,
      action:
        "Complete your profile for the unknown must-haves — if you use PostgreSQL, AWS or Docker, say so on your CV",
      rationale:
        "Half of this job's must-haves (req-3, req-4, req-5) are unknown, which flags the report low_confidence.",
      requirement_refs: ["req-3", "req-4", "req-5"],
    },
    {
      priority: 2,
      action: "Add Docker and CI/CD evidence to your CV — it is an explicit must-have",
      rationale: "req-5 asks for Docker/CI-CD and the profile is silent on it.",
      requirement_refs: ["req-5"],
    },
  ],
};

/** Recorded recommendations.v1 output for the all-unknown silent-profile report. */
const SILENT_RECOMMENDATIONS_RESPONSE = {
  recommendations: [
    {
      priority: 1,
      action: "Complete your profile — every must-have here is unknown, so the score cannot be trusted yet",
      rationale: "All three must-haves (req-a, req-b, req-c) are unknown, flagging the report low_confidence.",
      requirement_refs: ["req-a", "req-b", "req-c"],
    },
    {
      priority: 2,
      action: "State your years of experience explicitly on your CV",
      rationale: "req-a (5+ years) cannot be verified — the profile is silent on experience.",
      requirement_refs: ["req-a"],
    },
  ],
};

/** Recorded recommendations.v1 output for the zero-requirement vague-JD report. */
const VAGUE_RECOMMENDATIONS_RESPONSE = {
  recommendations: [
    {
      priority: 1,
      action: "Treat this score as meaningless — ask the employer for a fuller job description",
      rationale: "The JD states zero concrete requirements, so nothing was actually matched.",
      requirement_refs: [],
    },
    {
      priority: 2,
      action: "Keep your profile complete so a real JD can be matched accurately later",
      rationale: "With no stated requirements, profile completeness is what makes the next match trustworthy.",
      requirement_refs: [],
    },
  ],
};

const fintechProviders = () =>
  makeProvider([
    JSON.stringify(CV_EXTRACT_RESPONSE),
    JSON.stringify(FINTECH_EXTRACT_RESPONSE),
    JSON.stringify(FINTECH_VERDICTS_RESPONSE),
    JSON.stringify(FINTECH_RECOMMENDATIONS_RESPONSE),
  ]);

function reportOf(match: JobMatch): StoredMatchResultV2 {
  return match.result as StoredMatchResultV2;
}

describe("MatchService v2 (spec 003 §FR-6/§FR-7/§FR-8, T3.4)", () => {
  it("match with no profile auto-runs the pipeline, then matches (AC-3); usage ops recorded with tokens", async () => {
    const provider = fintechProviders();
    const { service, client, usage } = makeHarness(provider, {
      jobs: [seedJob(JOB_ID, fintechJd.jdText)],
    });

    const match = await service.match(USER, TOKEN, JOB_ID);
    const report = reportOf(match);

    // The pipeline ran inline and persisted a ready profile (AC-3).
    const profiles = client.table("candidate_profiles").rows;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ status: "ready", version: 1 });

    // 4 LLM calls: cv-extract (S1; S3 skipped, zero flags), jd-extract,
    // match-requirements, recommendations (T4.2). Raw CV text was never read
    // by the matcher itself.
    expect(provider.complete).toHaveBeenCalledTimes(4);

    // Report v2 shape: explainable score computed in code from the verdicts.
    expect(report.version).toBe(2);
    expect(report.weights_version).toBe("weights.v1");
    expect(report.template_versions).toEqual({
      cv_extract: "cv-extract.v1",
      jd_extract: "jd-extract.v1",
      match_requirements: "match-requirements.v1",
    });
    expect(report.verdicts.map((v) => v.requirement_id)).toEqual([
      "req-1",
      "req-2",
      "req-3",
      "req-4",
      "req-5",
      "req-6",
      "req-7",
      "req-8",
      "req-9",
    ]);
    expect(report.verdicts[0]).toMatchObject({ verdict: "match" }); // 9y ≥ 5y, pre-pass
    expect(report.verdicts[2]).toMatchObject({ verdict: "unknown" }); // PostgreSQL/Redis, LLM
    // must_have: 4 match + 3 unknown → 4.05/6 = 0.675; unknown share 3/6 > 0.4.
    expect(report.breakdown.must_have.component_score).toBeCloseTo(0.675);
    expect(report.unknown_must_have_share).toBeCloseTo(0.5);
    expect(report.low_confidence).toBe(true);
    expect(report.score).toBe(62);
    expect(match.score).toBe(report.score); // top-level column mirrors the report
    expect(report.jd_low_confidence).toBe(false); // full-length JD → no heuristic warning

    // Requirement snapshot (T3.5): the report carries the requirement
    // text/category/importance the verdicts reference — job_profiles is not
    // exposed over the API, so the UI renders from the report alone.
    expect(report.requirements).toHaveLength(9);
    expect(report.requirements[0]).toEqual({
      id: "req-1",
      text: "5+ years of backend development experience",
      category: "experience",
      importance: "must_have",
    });
    expect(
      report.verdicts.every((v) =>
        report.requirements.some((r) => r.id === v.requirement_id),
      ),
    ).toBe(true);

    // Recommendations (T4.2): computed with the report, stored on it,
    // grounded in the actual verdicts with valid requirement refs.
    expect(report.recommendations).toHaveLength(2);
    expect(report.recommendations?.[0]?.priority).toBe(1);
    expect(report.recommendations?.[1]?.action).toContain("Docker");
    expect(
      report.recommendations?.every((rec) =>
        rec.requirement_refs.every((ref) => report.requirements.some((r) => r.id === ref)),
      ),
    ).toBe(true);

    // Usage: one row per real LLM stage with tokens; the recommendations
    // gateway call IS the quota-counting 'job_match' row (real tokens roll up
    // on it — exactly one non-cache-hit job_match row per computed report).
    expect(usage.map((row) => row.operation)).toEqual([
      "cv_profile",
      "jd_extract",
      "match_requirements",
      "job_match",
    ]);
    expect(usage[0]).toMatchObject({ operation: "cv_profile", tokens_in: 100, tokens_out: 50, cache_hit: false });
    expect(usage[1]).toMatchObject({ operation: "jd_extract", tokens_in: 100, tokens_out: 50, cache_hit: false });
    expect(usage[2]).toMatchObject({ operation: "match_requirements", tokens_in: 100, tokens_out: 50, cache_hit: false });
    expect(usage[3]).toMatchObject({ operation: "job_match", tokens_in: 100, tokens_out: 50, cache_hit: false });
  });

  it("repeat match with identical inputs returns the stored row: zero LLM calls, bit-identical score (AC-4)", async () => {
    const provider = fintechProviders();
    const { service, client, usage } = makeHarness(provider, {
      jobs: [seedJob(JOB_ID, fintechJd.jdText)],
    });

    const first = await service.match(USER, TOKEN, JOB_ID);
    const second = await service.match(USER, TOKEN, JOB_ID);

    expect(provider.complete).toHaveBeenCalledTimes(4); // no new calls — incl. recommendations
    expect(client.table("job_matches").rows).toHaveLength(1); // no duplicate row
    expect(usage).toHaveLength(4); // quota not double-charged
    expect(second.id).toBe(first.id);
    expect(second.score).toBe(first.score);
    expect(second.result).toEqual(first.result);
    expect(reportOf(second).recommendations).toEqual(reportOf(first).recommendations);
  });

  it("pipeline failure fails the match — no raw-text fallback, no stored report", async () => {
    const provider = makeProvider([new Error("provider boom")]);
    const { service, client, usage } = makeHarness(provider, {
      jobs: [seedJob(JOB_ID, fintechJd.jdText)],
    });

    await expect(service.match(USER, TOKEN, JOB_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Only the failed cv-extract call happened — the matcher never proceeded
    // to jd-extract or any CV-text-based fallback.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(client.table("candidate_profiles").rows[0]).toMatchObject({ status: "failed" });
    expect(client.table("job_matches").rows).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it("short/vague JD keeps the low-confidence heuristic warning (jd-validation.ts)", async () => {
    const shortJd = "Rockstar ninja wanted. Apply now.";
    const provider = makeProvider([
      JSON.stringify(CV_EXTRACT_RESPONSE),
      JSON.stringify(VAGUE_EXTRACT_RESPONSE),
      JSON.stringify(VAGUE_RECOMMENDATIONS_RESPONSE),
    ]);
    const { service, usage } = makeHarness(provider, { jobs: [seedJob(JOB_ID, shortJd)] });

    const match = await service.match(USER, TOKEN, JOB_ID);
    const report = reportOf(match);

    expect(report.jd_low_confidence).toBe(true);
    expect(report.warning).toContain("short/vague");
    expect(report.low_confidence).toBe(false); // no must-haves → gate not triggered
    expect(report.verdicts).toEqual([]); // the vague JD states zero requirements
    expect(report.requirements).toEqual([]);
    expect(report.score).toBe(100); // no stated constraints → nothing unmet
    // match-requirements was skipped (nothing to classify); the only LLM
    // calls are cv-extract, jd-extract and recommendations (T4.2).
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(usage.map((row) => row.operation)).toEqual(["cv_profile", "jd_extract", "job_match"]);
    expect(usage[2]).toMatchObject({ operation: "job_match", tokens_in: 100, cache_hit: false });
    // No requirements → refs empty, but the advice is still report-grounded.
    expect(report.recommendations?.[0]?.requirement_refs).toEqual([]);
  });

  it(">40% must-have UNKNOWN → low_confidence report (spec §FR-8 gate)", async () => {
    const jdText = `Acme Corp is hiring a Platform Engineer for its developer infrastructure group.
The team builds the internal deployment platform used by all product squads.
You will design paved-path tooling, own the Kubernetes-based runtime, and drive
adoption across engineering. We value written communication, pragmatic design
documents, and a bias for automation over manual toil. The position is fully
remote within the EU, with quarterly offsites in Berlin and a generous learning
budget. We offer a competitive salary, equity, and 30 days of vacation.`;
    const stated = (value: unknown, evidence: string) => ({
      value,
      status: "stated",
      confidence: 0.9,
      evidence,
    });
    const unknownLeaf = { value: null, status: "unknown", confidence: 0, evidence: null };
    const job = seedJob(JOB_ID, jdText);
    const { service, provider, usage } = makeHarness(
      makeProvider([JSON.stringify(SILENT_RECOMMENDATIONS_RESPONSE)]),
      {
      jobs: [job],
      // A ready but silent profile (current for the CV) — the pipeline must
      // NOT re-run, and every requirement stays UNKNOWN, never MISSING.
      candidateProfiles: [
        {
          id: "profile-silent",
          user_id: USER,
          cv_id: CV_ID,
          version: 1,
          status: "ready",
          profile: emptyCandidateProfile(),
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
        },
      ],
      jobProfiles: [
        {
          id: "jp-1",
          job_id: JOB_ID,
          profile: {
            required_skills: [],
            preferred_skills: [],
            min_years_experience: unknownLeaf,
            industry: unknownLeaf,
            location: unknownLeaf,
            remote_policy: stated("remote", "fully remote"),
            languages: [],
            education_requirements: [],
            requirements: [
              {
                id: "req-a",
                text: stated("5+ years of experience", "5+ years of experience"),
                category: "experience",
                importance: "must_have",
              },
              {
                id: "req-b",
                text: stated("German language skills", "German language skills"),
                category: "language",
                importance: "must_have",
              },
              {
                id: "req-c",
                text: stated("Fully remote position", "fully remote"),
                category: "location",
                importance: "must_have",
              },
            ],
          },
          template_version: "jd-extract.v1",
          content_hash: job.content_hash,
          created_at: new Date(1_700_000_000_000).toISOString(),
        },
      ],
    });

    const match = await service.match(USER, TOKEN, JOB_ID);
    const report = reportOf(match);

    // Every matching stage resolved without the LLM (pipeline reused, job
    // profile reused, match-requirements skipped) — the only LLM call is
    // recommendations (T4.2) for the fresh report.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(report.verdicts).toHaveLength(3);
    expect(report.verdicts.every((v) => v.verdict === "unknown")).toBe(true);
    expect(report.unknown_must_have_share).toBe(1);
    expect(report.low_confidence).toBe(true);
    // UNKNOWN scores above MISSING on must-haves (0.35), so the score is not 0.
    expect(report.breakdown.must_have.component_score).toBeCloseTo(0.35);
    // Low-confidence report → profile completion is the first recommendation.
    expect(report.recommendations?.[0]?.action).toContain("Complete your profile");
    // A fresh match operation happened → exactly one non-cache-hit job_match
    // row (the recommendations call's own usage row).
    expect(usage.map((row) => row.operation)).toEqual(["job_match"]);
    expect(usage[0]).toMatchObject({ tokens_in: 100, cache_hit: false });
  });

  it("old v1 rows stay readable via getLatest; a new POST recomputes instead of reusing them", async () => {
    const v1Result = {
      score: 55,
      strengths: ["TypeScript"],
      gaps: ["PostgreSQL"],
      recommendations: ["Learn Docker"],
      low_confidence: false,
      template_version: "job-match.v1",
    };
    const provider = fintechProviders();
    const { service, client } = makeHarness(provider, {
      jobs: [seedJob(JOB_ID, fintechJd.jdText)],
      jobMatches: [
        {
          id: "v1-row",
          user_id: USER,
          cv_id: CV_ID,
          job_id: JOB_ID,
          score: 55,
          result: v1Result,
          created_at: new Date(1_600_000_000_000).toISOString(),
        },
      ],
    });

    // GET returns the v1 row as-is (the UI feature-detects on result.version).
    const legacy = await service.getLatest(USER, TOKEN, JOB_ID);
    expect(legacy.id).toBe("v1-row");
    expect(legacy.result).toEqual(v1Result);

    // POST does not trust the v1 row — it computes a fresh v2 report.
    const fresh = await service.match(USER, TOKEN, JOB_ID);
    expect(fresh.id).not.toBe("v1-row");
    expect(reportOf(fresh).version).toBe(2);
    expect(client.table("job_matches").rows).toHaveLength(2);

    const latest = await service.getLatest(USER, TOKEN, JOB_ID);
    expect(latest.id).toBe(fresh.id);
  });
});
