import { ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CvAnalysis } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { cvExtractV1 } from "../src/modules/ai/prompts/cv-extract.v1.js";
import { cvValidateV1 } from "../src/modules/ai/prompts/cv-validate.v1.js";
import {
  createCvReviewTemplate,
  CV_REVIEW_TEMPLATE_VERSION,
  type CvReviewInput,
} from "../src/modules/ai/prompts/cv-review.v2.js";
import { buildPrompt, UNTRUSTED_DATA_RULE } from "../src/modules/ai/prompts/prompt.types.js";
import { ProfilePipelineService } from "../src/modules/candidate-profiles/profile-pipeline.service.js";
import { CvReviewService } from "../src/modules/cv-review/cv-review.service.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import {
  CV_CONTENT_HASH,
  CV_EXTRACT_RESPONSE,
  CV_TEXT,
  fixtureProfile,
} from "./fixtures/cv-profile.fixture.js";

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";

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
 * Stateful Supabase mock (same pattern as match.spec.ts): real row storage
 * for cvs, candidate_profiles and cv_analyses so the inline pipeline run and
 * the stored analysis can be asserted. Service-role side: in-memory
 * llm_cache + usage_records.
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

  insert(payload: Row): this {
    this.mutation = { type: "insert", payload };
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
  service: CvReviewService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(
  provider: LlmProvider,
  seeds: { cvText?: string; cvContentHash?: string; candidateProfiles?: Row[]; cvAnalyses?: Row[] } = {},
): Harness {
  const client = new StatefulClient()
    .seed("cvs", [
      {
        id: CV_ID,
        user_id: USER,
        name: "Pasted CV",
        file_path: null,
        extracted_text: seeds.cvText ?? CV_TEXT,
        content_hash: seeds.cvContentHash ?? CV_CONTENT_HASH,
        is_active: true,
        created_at: new Date(1_700_000_000_000).toISOString(),
      },
    ])
    .seed("candidate_profiles", seeds.candidateProfiles ?? [])
    .seed("cv_analyses", seeds.cvAnalyses ?? []);

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
  const pipeline = new ProfilePipelineService(supabase, ai, cvs);
  return { service: new CvReviewService(supabase, ai, cvs, pipeline), provider, client, usage };
}

/** A ready, current profile row for the seeded CV (pipeline must NOT re-run). */
function readyProfileRow(profile: unknown, contentHash = CV_CONTENT_HASH): Row {
  return {
    id: "profile-1",
    user_id: USER,
    cv_id: CV_ID,
    version: 3,
    status: "ready",
    profile,
    stage_meta: {
      content_hash: contentHash,
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

/**
 * Recorded cv-review.v2 output for the fixture profile: one improvement cites
 * a real profile leaf, one cites a bogus path (the validator strips it —
 * documented policy: field_ref is a hint, never load-bearing), one has none.
 */
const REVIEW_RESPONSE = {
  score: 74,
  sections: [
    { name: "Impact", score: 70, feedback: "Strong scope signals, thin on outcomes." },
    { name: "Clarity", score: 80, feedback: "Readable, well structured." },
  ],
  improvements: [
    {
      priority: 1,
      title: "Quantify the payment API work",
      detail: "Add transaction volume or latency numbers to the Acme role.",
      field_ref: "roles[0].scope",
    },
    {
      priority: 2,
      title: "Fill the DevOps gap",
      detail: "Your profile is silent on devops tools — list what you actually use.",
      field_ref: "skills.devops_tools[9]",
    },
    {
      priority: 3,
      title: "Tighten the summary",
      detail: "Two lines max; lead with seniority and domain.",
    },
  ],
};

interface StoredReviewResult {
  score: number;
  sections: unknown[];
  improvements: Array<{ priority: number; title: string; detail: string; field_ref?: string }>;
  truncated: boolean;
  analyzed_chars: number;
  template_version: string;
  profile_version: number;
}

function resultOf(analysis: CvAnalysis): StoredReviewResult {
  return analysis.result as StoredReviewResult;
}

describe("cv-review.v2 template (spec 003 §FR-9/§FR-10, T4.1)", () => {
  const template = createCvReviewTemplate({ profile: fixtureProfile(), depth: "deep" });
  const input: CvReviewInput = {
    profile: fixtureProfile(),
    cvText: CV_TEXT,
    contentHash: CV_CONTENT_HASH,
    truncated: false,
  };

  it("builds a guarded prompt carrying the profile JSON and the CV text as data", () => {
    const prompt = buildPrompt(template, input);
    expect(prompt.templateVersion).toBe(CV_REVIEW_TEMPLATE_VERSION);
    expect(prompt.messages[0]?.content).toContain(UNTRUSTED_DATA_RULE);
    expect(prompt.messages[0]?.content).toContain("5-8"); // deep → 5-8 improvements
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("<candidate_profile>");
    expect(user).toContain('"programming_languages"'); // profile JSON present
    expect(user).toContain("Senior Backend Engineer"); // profile content
    expect(user).toContain("<cv_text>");
    expect(user).toContain(CV_TEXT.trim());
  });

  it("basic depth asks for 3 improvements and keeps the v1 token cap", () => {
    const basic = createCvReviewTemplate({ profile: fixtureProfile(), depth: "basic" });
    expect(buildPrompt(basic, input).messages[0]?.content).toContain("exactly 3");
    expect(basic.maxTokens).toBe(1500);
    expect(template.maxTokens).toBe(2500);
  });

  it("cache identity covers depth + content hash + profile content (user corrections invalidate)", () => {
    const base = template.cacheInput(input);
    expect(base).toContain(CV_CONTENT_HASH);
    const corrected = fixtureProfile();
    corrected.headline.title.value = "Staff Engineer";
    expect(template.cacheInput({ ...input, profile: corrected })).not.toBe(base);
    const basic = createCvReviewTemplate({ profile: fixtureProfile(), depth: "basic" });
    expect(basic.cacheInput(input)).not.toBe(base);
  });

  it("validate strips field_refs that do not resolve in the profile, keeps real ones", () => {
    const validated = template.validate(structuredClone(REVIEW_RESPONSE));
    expect(validated).not.toBeNull();
    expect(validated?.improvements[0]?.field_ref).toBe("roles[0].scope"); // resolves
    expect(validated?.improvements[1]?.field_ref).toBeUndefined(); // bogus → stripped
    expect(validated?.improvements[2]?.field_ref).toBeUndefined(); // none emitted
  });

  it("validate rejects broken shapes (triggers the gateway's repair retry)", () => {
    expect(template.validate(null)).toBeNull();
    expect(template.validate({ score: 101, sections: [], improvements: [] })).toBeNull();
    expect(template.validate({ score: 50, sections: [], improvements: "nope" })).toBeNull();
  });
});

describe("CvReviewService (spec 003 §FR-9, T4.1)", () => {
  it("analyze with an existing ready profile consumes it: profile JSON in the prompt, one LLM call", async () => {
    const provider = makeProvider([JSON.stringify(REVIEW_RESPONSE)]);
    const { service, client, usage } = makeHarness(provider, {
      candidateProfiles: [readyProfileRow(fixtureProfile())],
    });

    const analysis = await service.analyze(USER, TOKEN, CV_ID, "deep");
    const result = resultOf(analysis);

    // No pipeline run — the ready profile was reused; the only LLM call is the review.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(client.table("candidate_profiles").rows).toHaveLength(1);
    expect(usage.map((row) => row.operation)).toEqual(["cv_analysis"]);

    // The review call received the structured profile + raw text as data blocks.
    const messages = vi.mocked(provider.complete).mock.calls[0]?.[0].messages ?? [];
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("<candidate_profile>");
    expect(user).toContain('"programming_languages"');
    expect(user).toContain("<cv_text>");

    // Stored shape: the existing contract + additive field_ref + provenance.
    expect(analysis.score).toBe(74);
    expect(result.template_version).toBe("cv-review.v2");
    expect(result.profile_version).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.sections).toHaveLength(2);
    expect(result.improvements.map((i) => i.priority)).toEqual([1, 2, 3]);
    expect(result.improvements[0]?.field_ref).toBe("roles[0].scope");
    expect(result.improvements[1]?.field_ref).toBeUndefined();
  });

  it("analyze without a profile triggers the pipeline first, then reviews the profile", async () => {
    const provider = makeProvider([
      JSON.stringify(CV_EXTRACT_RESPONSE), // S1 cv-extract (S3 skipped, zero flags)
      JSON.stringify(REVIEW_RESPONSE), // cv-review.v2
    ]);
    const { service, client, usage } = makeHarness(provider);

    const analysis = await service.analyze(USER, TOKEN, CV_ID, "basic");

    // The pipeline ran inline and persisted a ready profile (spec §FR-6 pattern).
    const profiles = client.table("candidate_profiles").rows;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ status: "ready", version: 1 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(usage.map((row) => row.operation)).toEqual(["cv_profile", "cv_analysis"]);
    expect(analysis.score).toBe(74);
  });

  it("pipeline failure → 503, no analysis stored, no raw-text-only review call", async () => {
    const provider = makeProvider([new Error("provider boom")]);
    const { service, client, usage } = makeHarness(provider);

    await expect(service.analyze(USER, TOKEN, CV_ID, "basic")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Only the failed cv-extract call happened — the review never ran on raw text.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(client.table("candidate_profiles").rows[0]).toMatchObject({ status: "failed" });
    expect(client.table("cv_analyses").rows).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it("raw CV text is capped at the review limit; truncation is disclosed", async () => {
    const longText = `${CV_TEXT}\n${"achievement line\n".repeat(2000)}`; // ~34k chars
    const longHash = "long-cv-hash";
    const provider = makeProvider([JSON.stringify(REVIEW_RESPONSE)]);
    const { service } = makeHarness(provider, {
      cvText: longText,
      cvContentHash: longHash,
      candidateProfiles: [readyProfileRow(fixtureProfile(), longHash)],
    });

    const analysis = await service.analyze(USER, TOKEN, CV_ID, "basic");
    const result = resultOf(analysis);

    expect(result.truncated).toBe(true);
    expect(result.analyzed_chars).toBeLessThan(longText.length);
    expect(result.analyzed_chars).toBeLessThanOrEqual(12_000 + "\n[...truncated]".length);
    const messages = vi.mocked(provider.complete).mock.calls[0]?.[0].messages ?? [];
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("[...truncated]");
  });

  it("re-analyzing an unchanged CV + profile is a cache hit (content-hash keyed, unchanged from v1)", async () => {
    const provider = makeProvider([JSON.stringify(REVIEW_RESPONSE)]);
    const { service, usage } = makeHarness(provider, {
      candidateProfiles: [readyProfileRow(fixtureProfile())],
    });

    await service.analyze(USER, TOKEN, CV_ID, "basic");
    await service.analyze(USER, TOKEN, CV_ID, "basic");

    expect(provider.complete).toHaveBeenCalledTimes(1); // second analyze hit llm_cache
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ operation: "cv_analysis", cache_hit: false, tokens_in: 100 });
    expect(usage[1]).toMatchObject({
      operation: "cv_analysis",
      cache_hit: true,
      tokens_in: 0,
      tokens_out: 0,
    });
  });

  it("a CV without text is rejected 422 before any LLM work", async () => {
    const provider = makeProvider([]);
    const { service, client } = makeHarness(provider);
    client.table("cvs").rows[0]!.extracted_text = null;

    await expect(service.analyze(USER, TOKEN, CV_ID, "basic")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });

  it("old v1 analysis rows stay readable via listAnalyses (no migration, shape compatible)", async () => {
    const v1Result = {
      score: 61,
      sections: [{ name: "Impact", score: 55, feedback: "Thin on outcomes." }],
      improvements: ["Add metrics to your bullets", "Tighten the summary"],
      truncated: false,
      analyzed_chars: 4200,
      template_version: "cv-analysis.v1",
    };
    const { service } = makeHarness(makeProvider([]), {
      cvAnalyses: [
        {
          id: "old-row",
          cv_id: CV_ID,
          user_id: USER,
          score: 61,
          result: v1Result,
          depth: "basic",
          created_at: new Date(1_600_000_000_000).toISOString(),
        },
      ],
    });

    const analyses = await service.listAnalyses(USER, TOKEN, CV_ID);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.id).toBe("old-row");
    expect(analyses[0]?.result).toEqual(v1Result);
  });
});
