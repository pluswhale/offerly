import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CvImprovement } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  createBulletImproveTemplate,
  BULLET_IMPROVE_TEMPLATE_VERSION,
  type BulletImproveInput,
} from "../src/modules/ai/prompts/bullet-improve.v1.js";
import {
  createSentenceRewriteTemplate,
  SENTENCE_REWRITE_TEMPLATE_VERSION,
  type SentenceRewriteInput,
} from "../src/modules/ai/prompts/sentence-rewrite.v1.js";
import { buildPrompt, UNTRUSTED_DATA_RULE } from "../src/modules/ai/prompts/prompt.types.js";
import {
  CvImprovementsService,
  type BulletImprovementsPayload,
  type SentenceImprovementsPayload,
} from "../src/modules/cv-improvements/cv-improvements.service.js";
import { findNewEntities } from "../src/modules/cv-improvements/entity-guard.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";

/** Fixture CV with planted weak sentences (spec 003 §FR-12 heuristics). */
const CV_TEXT = [
  "Jane Doe",
  "Senior Backend Engineer",
  "",
  "Experience",
  "",
  "Acme Corp — Backend Engineer (2019–2024)",
  "Responsible for maintaining the payment service.",
  "Worked on the migration of the billing platform.",
  "I was responsible for onboarding new engineers.",
  "Successfully delivered various internal tools very quickly.",
].join("\n");
const CV_CONTENT_HASH = "cv-hash-1";

/** Same mock style as cv-review.spec.ts: queued provider responses. */
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

/** Recorded sentence-rewrite.v1 output: categorized rewrites, spans verbatim. */
const REWRITE_RESPONSE = {
  suggestions: [
    {
      original_span: "Responsible for maintaining the payment service.",
      improved: "Maintained the payment service across all releases.",
      reason: "'Responsible for' is a duty statement that hides ownership.",
      category: "vague_responsibility",
    },
    {
      original_span: "Worked on the migration of the billing platform.",
      improved: "Migrated the billing platform.",
      reason: "'Worked on' is vague — lead with the action verb.",
      category: "vague_responsibility",
    },
    {
      original_span: "I was responsible for onboarding new engineers.",
      improved: "Onboarded new engineers.",
      reason: "CVs use implied first person — 'I was responsible for' adds narration.",
      category: "first_person",
    },
    {
      original_span: "Successfully delivered various internal tools very quickly.",
      improved: "Delivered internal tools.",
      reason: "'Successfully', 'various' and 'very' are filler words that add no information.",
      category: "filler_words",
    },
  ],
};

/** One verbatim suggestion + one fabricated span that must be dropped (spec AC-6). */
const FABRICATED_SPAN_RESPONSE = {
  suggestions: [
    REWRITE_RESPONSE.suggestions[0],
    {
      original_span: "Led a team of 12 engineers at Globex.",
      improved: "Led a team of 12 engineers.",
      reason: "Fabricated — this sentence does not exist in the CV.",
      category: "missing_action_verb",
    },
  ],
};

/** Stateful Supabase mock (same pattern as cv-review.spec.ts). */
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
  service: CvImprovementsService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(
  provider: LlmProvider,
  seeds: { cvText?: string | null; improvements?: Row[] } = {},
): Harness {
  const client = new StatefulClient()
    .seed("cvs", [
      {
        id: CV_ID,
        user_id: USER,
        name: "Pasted CV",
        file_path: null,
        extracted_text: seeds.cvText === undefined ? CV_TEXT : seeds.cvText,
        content_hash: CV_CONTENT_HASH,
        is_active: true,
        created_at: new Date(1_700_000_000_000).toISOString(),
      },
    ])
    .seed("cv_improvements", seeds.improvements ?? []);

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
  return { service: new CvImprovementsService(supabase, ai, cvs), provider, client, usage };
}

function payloadOf(row: CvImprovement): SentenceImprovementsPayload {
  return row.suggestions as SentenceImprovementsPayload;
}

describe("sentence-rewrite.v1 template (spec 003 §FR-12/§FR-10, T5.1)", () => {
  const template = createSentenceRewriteTemplate({ depth: "basic" });
  const input: SentenceRewriteInput = {
    cvText: CV_TEXT,
    contentHash: CV_CONTENT_HASH,
    truncated: false,
  };

  it("builds a guarded prompt naming every detection category and the depth cap", () => {
    const prompt = buildPrompt(template, input);
    expect(prompt.templateVersion).toBe(SENTENCE_REWRITE_TEMPLATE_VERSION);
    const system = prompt.messages[0]?.content ?? "";
    expect(system).toContain(UNTRUSTED_DATA_RULE);
    expect(system).toContain("at most 5"); // basic cap
    for (const category of [
      "vague_responsibility",
      "missing_action_verb",
      "missing_outcome",
      "first_person",
      "paragraph_should_be_bullets",
      "filler_words",
      "overlong_sentence",
    ]) {
      expect(system).toContain(category);
    }
    // Verbatim-quote + no-new-facts rules are load-bearing.
    expect(system).toContain("verbatim quote");
    expect(system).toContain("Never add facts");
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("<cv_text>");
    expect(user).toContain(CV_TEXT);
  });

  it("deep depth asks for 12 suggestions and a larger token cap; both tiers are cheap", () => {
    const deep = createSentenceRewriteTemplate({ depth: "deep" });
    expect(buildPrompt(deep, input).messages[0]?.content).toContain("at most 12");
    expect(template.maxTokens).toBe(1500);
    expect(deep.maxTokens).toBe(2500);
    expect(template.modelTier).toBe("cheap");
    expect(deep.modelTier).toBe("cheap");
  });

  it("cache identity is depth + content hash", () => {
    expect(template.cacheInput(input)).toBe(`basic:${CV_CONTENT_HASH}`);
    const deep = createSentenceRewriteTemplate({ depth: "deep" });
    expect(deep.cacheInput(input)).not.toBe(template.cacheInput(input));
  });

  it("validate accepts schema-valid output and slices extras down to the depth cap", () => {
    const validated = template.validate(structuredClone(REWRITE_RESPONSE));
    expect(validated?.suggestions).toHaveLength(4);

    const extras = {
      suggestions: Array.from({ length: 7 }, (_, i) => ({
        original_span: `span ${i}`,
        improved: `improved ${i}`,
        reason: `reason ${i}`,
        category: "filler_words",
      })),
    };
    expect(template.validate(extras)?.suggestions).toHaveLength(5); // basic cap
  });

  it("validate rejects broken shapes (triggers the gateway's repair retry)", () => {
    expect(template.validate(null)).toBeNull();
    expect(template.validate({ suggestions: "nope" })).toBeNull();
    expect(
      template.validate({
        suggestions: [{ original_span: "x", improved: "y", reason: "z", category: "bogus" }],
      }),
    ).toBeNull();
  });
});

describe("CvImprovementsService (spec 003 §FR-12, T5.1)", () => {
  it("stores categorized rewrites with per-suggestion id + pending status, one cv_improve op", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service, client, usage } = makeHarness(provider);

    const row = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const payload = payloadOf(row);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage.map((record) => record.operation)).toEqual(["cv_improve"]);
    expect(row.type).toBe("sentence");
    expect(row.template_version).toBe(SENTENCE_REWRITE_TEMPLATE_VERSION);
    expect(payload.content_hash).toBe(CV_CONTENT_HASH);
    expect(payload.depth).toBe("basic");
    expect(payload.dropped_count).toBe(0);
    expect(payload.items).toHaveLength(4);
    for (const item of payload.items) {
      expect(item.id).toBeTruthy();
      expect(item.status).toBe("pending");
      expect(item.reason.length).toBeGreaterThan(0);
      // Every stored span locates verbatim in the CV text (spec AC-6).
      expect(CV_TEXT).toContain(item.original_span);
    }
    expect(payload.items[0]?.category).toBe("vague_responsibility");
    expect(payload.items[2]?.category).toBe("first_person");
    expect(payload.items[3]?.category).toBe("filler_words");
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("drops suggestions whose original_span is fabricated, counting them in the payload", async () => {
    const provider = makeProvider([JSON.stringify(FABRICATED_SPAN_RESPONSE)]);
    const { service } = makeHarness(provider);

    const row = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const payload = payloadOf(row);

    expect(payload.dropped_count).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.original_span).toBe(
      "Responsible for maintaining the payment service.",
    );
    // The fabricated span never reached storage.
    expect(JSON.stringify(row.suggestions)).not.toContain("Globex");
  });

  it("repeat POST for the same CV content + depth returns the stored row, zero extra LLM calls", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service, client } = makeHarness(provider);

    const first = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const second = await service.generateSentences(USER, TOKEN, CV_ID, "basic");

    expect(provider.complete).toHaveBeenCalledTimes(1); // reuse, not even a cache hit
    expect(second.id).toBe(first.id);
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("a different depth is a different reuse key — a fresh row is generated", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service, client } = makeHarness(provider);

    await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const deep = await service.generateSentences(USER, TOKEN, CV_ID, "deep");

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(payloadOf(deep).depth).toBe("deep");
    expect(client.table("cv_improvements").rows).toHaveLength(2);
  });

  it("a run with zero weak sentences stores an empty result without error", async () => {
    const provider = makeProvider([JSON.stringify({ suggestions: [] })]);
    const { service, client } = makeHarness(provider);

    const row = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const payload = payloadOf(row);

    expect(payload.items).toEqual([]);
    expect(payload.dropped_count).toBe(0);
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("PATCH flips one suggestion's status and leaves the others pending", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service } = makeHarness(provider);

    const row = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    const target = payloadOf(row).items[1]!;
    const updated = await service.updateSuggestionStatus(
      USER,
      TOKEN,
      CV_ID,
      row.id,
      target.id,
      "accepted",
    );

    const payload = payloadOf(updated);
    expect(payload.items[1]?.status).toBe("accepted");
    expect(payload.items[0]?.status).toBe("pending");
    expect(payload.items[2]?.status).toBe("pending");
  });

  it("PATCH with an unknown suggestion or row id is a 404", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service } = makeHarness(provider);

    const row = await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    await expect(
      service.updateSuggestionStatus(USER, TOKEN, CV_ID, row.id, "no-such-id", "rejected"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateSuggestionStatus(USER, TOKEN, CV_ID, "no-such-row", "whatever", "rejected"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("another user's CV is a 404 (same ownership pattern as analyze)", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service } = makeHarness(provider);

    await expect(
      service.generateSentences("user-2", TOKEN, CV_ID, "basic"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });

  it("a CV without text is rejected 422 before any LLM work", async () => {
    const provider = makeProvider([]);
    const { service } = makeHarness(provider, { cvText: null });

    await expect(service.generateSentences(USER, TOKEN, CV_ID, "basic")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });

  it("GET list returns all rows for the CV, newest first", async () => {
    const provider = makeProvider([JSON.stringify(REWRITE_RESPONSE)]);
    const { service } = makeHarness(provider);

    await service.generateSentences(USER, TOKEN, CV_ID, "basic");
    await service.generateSentences(USER, TOKEN, CV_ID, "deep");

    const rows = await service.list(USER, TOKEN, CV_ID);
    expect(rows).toHaveLength(2);
    expect(payloadOf(rows[0]!).depth).toBe("deep"); // newest first
    expect(payloadOf(rows[1]!).depth).toBe("basic");
  });
});

/* ---------------------------------------------------------------------------
 * T5.2 — bullet-improve.v1 + new-entity guard (spec 003 §FR-13)
 * ------------------------------------------------------------------------- */

/** Fixture CV with planted weak-verb / metric-less bullets (spec §FR-13). */
const BULLET_CV_TEXT = [
  "John Smith",
  "Platform Engineer",
  "",
  "Experience",
  "",
  "Initech — Platform Engineer (2020–2024)",
  "Helped maintain the CI pipeline for the payments team.",
  "Assisted with on-call incident response.",
  "Improved dashboard load times.",
  "Participated in code reviews for the billing service.",
].join("\n");

/** Recorded bullet-improve.v1 output: categorized rewrites, spans verbatim. */
const BULLET_RESPONSE = {
  suggestions: [
    {
      original_span: "Helped maintain the CI pipeline for the payments team.",
      improved: "Maintained the CI pipeline for the payments team, cutting build times by [X]%.",
      reason: "'Helped' is a weak verb that undersells ownership — lead with what you did.",
      category: "weak_action_verb",
    },
    {
      original_span: "Improved dashboard load times.",
      improved: "Reduced dashboard p95 load time by [X]%, speeding up analyst reporting.",
      reason: "'Improved' claims an achievement with no metric — add one you can defend.",
      category: "missing_metric",
    },
    {
      original_span: "Participated in code reviews for the billing service.",
      improved: "Reviewed code across the billing service, catching defects before release.",
      reason: "'Participated in' hides your actual contribution.",
      category: "weak_action_verb",
    },
  ],
};

/**
 * Planted hallucinations (spec AC-6): a rewrite naming Kubernetes although
 * the original span never does (new-entity guard), plus a fabricated span
 * that does not exist in the CV (verbatim check). Both must be dropped.
 */
const HALLUCINATION_RESPONSE = {
  suggestions: [
    BULLET_RESPONSE.suggestions[0],
    {
      original_span: "Assisted with on-call incident response.",
      improved: "Led Kubernetes incident response for production clusters, cutting MTTR by [X]%.",
      reason: "'Assisted' is a weak verb — own the work.",
      category: "weak_action_verb",
    },
    {
      original_span: "Managed the Kubernetes rollout for all of Globex.",
      improved: "Managed the rollout, cutting deploy time by [X]%.",
      reason: "Fabricated — this bullet does not exist in the CV.",
      category: "missing_impact",
    },
  ],
};

function bulletPayloadOf(row: CvImprovement): BulletImprovementsPayload {
  return row.suggestions as BulletImprovementsPayload;
}

describe("bullet-improve.v1 template (spec 003 §FR-13/§FR-10, T5.2)", () => {
  const template = createBulletImproveTemplate({ depth: "basic" });
  const input: BulletImproveInput = {
    cvText: BULLET_CV_TEXT,
    contentHash: CV_CONTENT_HASH,
    truncated: false,
  };

  it("builds a guarded prompt naming every detection category, the depth cap, and the honesty rules", () => {
    const prompt = buildPrompt(template, input);
    expect(prompt.templateVersion).toBe(BULLET_IMPROVE_TEMPLATE_VERSION);
    const system = prompt.messages[0]?.content ?? "";
    expect(system).toContain(UNTRUSTED_DATA_RULE);
    expect(system).toContain("at most 5"); // basic cap
    for (const category of [
      "weak_action_verb",
      "missing_metric",
      "missing_impact",
      "vague_wording",
    ]) {
      expect(system).toContain(category);
    }
    // Load-bearing rules: verbatim spans, never add facts, metrics are
    // bracketed placeholders, never invented numbers.
    expect(system).toContain("verbatim quote");
    expect(system).toContain("NEVER add facts");
    expect(system).toContain("NEVER invent numbers");
    expect(system).toContain("[X]%");
    expect(system).toContain("bracket");
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("<cv_text>");
    expect(user).toContain(BULLET_CV_TEXT);
  });

  it("deep depth asks for 12 suggestions and a larger token cap; both tiers are cheap", () => {
    const deep = createBulletImproveTemplate({ depth: "deep" });
    expect(buildPrompt(deep, input).messages[0]?.content).toContain("at most 12");
    expect(template.maxTokens).toBe(1500);
    expect(deep.maxTokens).toBe(2500);
    expect(template.modelTier).toBe("cheap");
    expect(deep.modelTier).toBe("cheap");
  });

  it("cache identity is depth + content hash, distinct from the sentence template's", () => {
    expect(template.cacheInput(input)).toBe(`basic:${CV_CONTENT_HASH}`);
    const deep = createBulletImproveTemplate({ depth: "deep" });
    expect(deep.cacheInput(input)).not.toBe(template.cacheInput(input));
    // Same input under a different templateVersion → different cache key.
    expect(template.templateVersion).not.toBe(SENTENCE_REWRITE_TEMPLATE_VERSION);
  });

  it("validate accepts schema-valid output and slices extras down to the depth cap", () => {
    const validated = template.validate(structuredClone(BULLET_RESPONSE));
    expect(validated?.suggestions).toHaveLength(3);

    const extras = {
      suggestions: Array.from({ length: 7 }, (_, i) => ({
        original_span: `span ${i}`,
        improved: `improved ${i}`,
        reason: `reason ${i}`,
        category: "missing_metric",
      })),
    };
    expect(template.validate(extras)?.suggestions).toHaveLength(5); // basic cap
  });

  it("validate rejects broken shapes (triggers the gateway's repair retry)", () => {
    expect(template.validate(null)).toBeNull();
    expect(template.validate({ suggestions: "nope" })).toBeNull();
    expect(
      template.validate({
        suggestions: [{ original_span: "x", improved: "y", reason: "z", category: "bogus" }],
      }),
    ).toBeNull();
  });
});

describe("new-entity guard (spec 003 §FR-13, T5.2)", () => {
  it("flags a technology absent from the original span (the AC-6 hallucination)", () => {
    const violations = findNewEntities(
      "Assisted with on-call incident response.",
      "Led Kubernetes incident response for production clusters, cutting MTTR by [X]%.",
    );
    expect(violations).toContain("kubernetes");
  });

  it("aliases fold — 'k8s' in the original covers 'Kubernetes' in the rewrite", () => {
    expect(
      findNewEntities("maintained the k8s clusters", "Operated Kubernetes clusters, cutting deploy time by [X]%"),
    ).toEqual([]);
  });

  it("bracketed placeholders are exempt — [X]% and [N] are never entities", () => {
    expect(
      findNewEntities(
        "Improved dashboard load times.",
        "Reduced dashboard p95 load time by [X]%, serving [N] analysts.",
      ),
    ).toEqual([]);
  });

  it("flags a multiword product/company name absent from the original span", () => {
    const violations = findNewEntities(
      "improved internal dashboards",
      "Improved internal dashboards for Google Cloud customers.",
    );
    expect(violations).toContain("Google Cloud");
  });

  it("passes rewrites that restructure without new entities", () => {
    expect(
      findNewEntities(
        "Helped maintain the CI pipeline for the payments team.",
        "Maintained the CI pipeline for the payments team, cutting build times by [X]%.",
      ),
    ).toEqual([]);
  });
});

describe("CvImprovementsService bullets (spec 003 §FR-13, T5.2)", () => {
  function makeBulletHarness(provider: LlmProvider, seeds: { cvText?: string | null } = {}) {
    return makeHarness(provider, {
      cvText: seeds.cvText === undefined ? BULLET_CV_TEXT : seeds.cvText,
    });
  }

  it("stores categorized bullet rewrites with placeholder metrics intact, one cv_improve op", async () => {
    const provider = makeProvider([JSON.stringify(BULLET_RESPONSE)]);
    const { service, usage } = makeBulletHarness(provider);

    const row = await service.generateBullets(USER, TOKEN, CV_ID, "basic");
    const payload = bulletPayloadOf(row);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage.map((record) => record.operation)).toEqual(["cv_improve"]);
    expect(row.type).toBe("bullet");
    expect(row.template_version).toBe(BULLET_IMPROVE_TEMPLATE_VERSION);
    expect(payload.content_hash).toBe(CV_CONTENT_HASH);
    expect(payload.depth).toBe("basic");
    expect(payload.dropped_count).toBe(0);
    expect(payload.items).toHaveLength(3);
    for (const item of payload.items) {
      expect(item.status).toBe("pending");
      expect(item.reason.length).toBeGreaterThan(0);
      // Every stored span locates verbatim in the CV text (spec AC-6).
      expect(BULLET_CV_TEXT).toContain(item.original_span);
    }
    // Weak-verb fixture bullets yield stronger-verb rewrites.
    expect(payload.items[0]?.category).toBe("weak_action_verb");
    expect(payload.items[0]?.improved.startsWith("Maintained")).toBe(true);
    expect(payload.items[0]?.improved).not.toContain("Helped");
    // Placeholder metrics survive storage — bracketed, user fill-in.
    expect(payload.items[1]?.category).toBe("missing_metric");
    expect(payload.items[1]?.improved).toContain("[X]%");
  });

  it("drops planted hallucinations: new entities AND fabricated spans (spec AC-6)", async () => {
    const provider = makeProvider([JSON.stringify(HALLUCINATION_RESPONSE)]);
    const { service } = makeBulletHarness(provider);

    const row = await service.generateBullets(USER, TOKEN, CV_ID, "basic");
    const payload = bulletPayloadOf(row);

    expect(payload.dropped_count).toBe(2);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.original_span).toBe(
      "Helped maintain the CI pipeline for the payments team.",
    );
    // The hallucinated technology and the fabricated span never reached storage.
    expect(JSON.stringify(row.suggestions)).not.toContain("Kubernetes");
    expect(JSON.stringify(row.suggestions)).not.toContain("Globex");
  });

  it("repeat POST for the same CV content + depth returns the stored row, zero extra LLM calls", async () => {
    const provider = makeProvider([JSON.stringify(BULLET_RESPONSE)]);
    const { service, client } = makeBulletHarness(provider);

    const first = await service.generateBullets(USER, TOKEN, CV_ID, "basic");
    const second = await service.generateBullets(USER, TOKEN, CV_ID, "basic");

    expect(provider.complete).toHaveBeenCalledTimes(1); // reuse, not even a cache hit
    expect(second.id).toBe(first.id);
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("sentence and bullet rows have independent reuse keys on the same CV", async () => {
    const provider = makeProvider([JSON.stringify(BULLET_RESPONSE)]);
    const { service, client } = makeBulletHarness(provider);

    await service.generateBullets(USER, TOKEN, CV_ID, "basic");
    const deep = await service.generateBullets(USER, TOKEN, CV_ID, "deep");

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(bulletPayloadOf(deep).depth).toBe("deep");
    expect(client.table("cv_improvements").rows).toHaveLength(2);
  });

  it("PATCH flips one bullet suggestion's status and leaves the others pending", async () => {
    const provider = makeProvider([JSON.stringify(BULLET_RESPONSE)]);
    const { service } = makeBulletHarness(provider);

    const row = await service.generateBullets(USER, TOKEN, CV_ID, "basic");
    const target = bulletPayloadOf(row).items[0]!;
    const updated = await service.updateSuggestionStatus(
      USER,
      TOKEN,
      CV_ID,
      row.id,
      target.id,
      "rejected",
    );

    const payload = bulletPayloadOf(updated);
    expect(payload.items[0]?.status).toBe("rejected");
    expect(payload.items[1]?.status).toBe("pending");
    expect(payload.items[2]?.status).toBe("pending");
  });

  it("a CV without text is rejected 422 before any LLM work", async () => {
    const provider = makeProvider([]);
    const { service } = makeBulletHarness(provider, { cvText: null });

    await expect(service.generateBullets(USER, TOKEN, CV_ID, "basic")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });
});
