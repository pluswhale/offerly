import { describe, expect, it, vi } from "vitest";
import type { CandidateProfile } from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import { verifyCandidateProfileEvidence } from "../src/modules/ai/evidence.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  collectConsistencyFlags,
  collectValidationItems,
  DURATION_INCONSISTENT_FLAG,
  excerptAround,
  LOW_CONFIDENCE_FLAG,
  MULTIPLE_CURRENT_ROLES_FLAG,
  runValidation,
} from "../src/modules/ai/profile-validation.js";
import {
  cvValidateV1,
  type CvValidateItem,
} from "../src/modules/ai/prompts/cv-validate.v1.js";
import { buildPrompt } from "../src/modules/ai/prompts/prompt.types.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import {
  CV_TEXT,
  fixtureProfile,
} from "./fixtures/cv-profile.fixture.js";

// Same mock style as cv-extract.spec.ts: queued provider responses + in-memory
// llm_cache/usage_records.
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

function makeSupabase() {
  const cache = new Map<string, unknown>();
  const usage: Array<Record<string, unknown>> = [];
  const client = {
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
  const supabase = { getServiceClient: () => client } as unknown as SupabaseService;
  return { supabase, usage };
}

function makeItem(overrides: Partial<CvValidateItem> = {}): CvValidateItem {
  return {
    path: "skills.devops_tools[0]",
    flag: "evidence_unverified",
    value: "Kubernetes",
    evidence: "deployed Kubernetes clusters to AWS",
    excerpt: excerptAround(CV_TEXT, "deployed Kubernetes clusters to AWS", "Kubernetes"),
    ...overrides,
  };
}

describe("cv-validate.v1 template (spec 003 §FR-1/§FR-10, T2.3)", () => {
  it("is versioned and on the strong model tier", () => {
    expect(cvValidateV1.templateVersion).toBe("cv-validate.v1");
    expect(cvValidateV1.modelTier).toBe("strong");
  });

  it("cacheInput identifies the flagged-item set, not the excerpts", () => {
    const a = buildPrompt(cvValidateV1, { items: [makeItem()] });
    const b = buildPrompt(cvValidateV1, {
      items: [makeItem({ excerpt: "a totally different excerpt" })],
    });
    expect(a.cacheInput).toBe(b.cacheInput);
    const c = buildPrompt(cvValidateV1, { items: [makeItem({ value: "Docker" })] });
    expect(c.cacheInput).not.toBe(a.cacheInput);
  });

  it("wraps each excerpt as untrusted data and never sees the full CV", () => {
    const prompt = buildPrompt(cvValidateV1, { items: [makeItem()] });
    expect(prompt.messages[0]?.content).toContain("untrusted user-provided data");
    expect(prompt.messages[1]?.content).toContain("<cv_excerpt>");
    expect(prompt.messages[1]?.content.length).toBeLessThan(CV_TEXT.length + 800);
  });

  it("validate accepts a schema-valid adjudication set", () => {
    const raw = {
      adjudications: [
        { path: "skills.devops_tools[0]", action: "drop", reason: "Not in the excerpt." },
        {
          path: "headline.title",
          action: "correct",
          corrected: { value: "Backend Engineer", evidence: "Senior Backend Engineer" },
          reason: "Excerpt says Senior Backend Engineer.",
        },
      ],
    };
    expect(cvValidateV1.validate(raw)).not.toBeNull();
  });

  it("validate rejects 'correct' without a corrected value and items without a reason", () => {
    expect(
      cvValidateV1.validate({
        adjudications: [{ path: "p", action: "correct", reason: "x" }],
      }),
    ).toBeNull();
    expect(
      cvValidateV1.validate({ adjudications: [{ path: "p", action: "keep" }] }),
    ).toBeNull();
  });
});

describe("excerptAround (T2.3)", () => {
  it("centers ±300 chars around the evidence span", () => {
    const needle = "Built services in TypeScript and NestJS";
    const excerpt = excerptAround(CV_TEXT, needle, null);
    expect(excerpt).toContain(needle);
    expect(excerpt.length).toBeLessThanOrEqual(needle.length + 600);
  });

  it("falls back to the headline region when nothing is locatable", () => {
    const excerpt = excerptAround(CV_TEXT, null, null);
    expect(excerpt).toBe(CV_TEXT.slice(0, 600));
    expect(excerpt).toContain("Jane Doe");
  });
});

describe("consistency flags (T2.3)", () => {
  it("flags summed role durations diverging from stated total years", () => {
    const profile = fixtureProfile();
    profile.headline.total_years_experience = {
      value: 20,
      status: "stated",
      confidence: 0.9,
      evidence: "Jun 2015 - Feb 2019",
    };
    const flags = collectConsistencyFlags(profile);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      path: "headline.total_years_experience",
      flag: DURATION_INCONSISTENT_FLAG,
      value: 20,
    });
  });

  it("does not flag when the sum is within tolerance, and skips unparseable dates", () => {
    const profile = fixtureProfile(); // stated 9, summed ~11 → ratio ~1.2, fine
    expect(collectConsistencyFlags(profile)).toEqual([]);

    const undated = fixtureProfile();
    undated.roles[0]!.start = {
      value: "a while ago",
      status: "stated",
      confidence: 0.5,
      evidence: "EXPERIENCE",
    };
    expect(collectConsistencyFlags(undated)).toEqual([]);
  });

  it("flags more than one current role", () => {
    const profile = fixtureProfile();
    profile.roles[1]!.is_current = true;
    const flags = collectConsistencyFlags(profile);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      path: "roles[1].end",
      flag: MULTIPLE_CURRENT_ROLES_FLAG,
    });
  });
});

describe("collectValidationItems (spec §FR-1 S3 input set)", () => {
  it("includes S2-flagged + low-confidence items and attaches excerpts", () => {
    const profile = fixtureProfile();
    // Low-confidence stated item (confidence < 0.7), evidence verifies fine.
    profile.skills.frameworks[0]!.confidence = 0.5;
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    const items = collectValidationItems(profile, report, CV_TEXT);
    const lowConfidence = items.find((i) => i.path === "skills.frameworks[0]");
    expect(lowConfidence).toMatchObject({ flag: LOW_CONFIDENCE_FLAG, value: "NestJS" });
    expect(lowConfidence?.excerpt).toContain("NestJS");
    // High-confidence verified items are never sent (spec §FR-1).
    expect(items.some((i) => i.path === "headline.title")).toBe(false);
  });

  it("does not duplicate a path already flagged by S2", () => {
    const profile = fixtureProfile();
    profile.skills.devops_tools.push({
      value: "Kubernetes",
      status: "stated",
      confidence: 0.3,
      evidence: "deployed Kubernetes clusters to AWS",
    });
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(report.flagged).toHaveLength(1);
    const items = collectValidationItems(profile, report, CV_TEXT);
    expect(items.filter((i) => i.path === "skills.devops_tools[0]")).toHaveLength(1);
  });
});

describe("runValidation (S3, T2.3)", () => {
  function profileWithFabrication(): CandidateProfile {
    const profile = fixtureProfile();
    profile.skills.devops_tools.push({
      value: "Kubernetes",
      status: "stated",
      confidence: 0.4,
      evidence: "deployed Kubernetes clusters to AWS",
    });
    return profile;
  }

  function itemsFor(profile: CandidateProfile): CvValidateItem[] {
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    return collectValidationItems(profile, report, CV_TEXT);
  }

  it("skips the LLM entirely when there is nothing to adjudicate (zero usage)", async () => {
    const provider = makeProvider([]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);
    const profile = fixtureProfile();

    const result = await runValidation(ai, {
      userId: "user-1",
      profile,
      flaggedItems: [],
      cvText: CV_TEXT,
    });
    expect(result.profile).toBe(profile); // unchanged, same reference
    expect(result.adjudicatedCount).toBe(0);
    expect(result.meta.skipped).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(usage).toEqual([]);
  });

  it("a planted fabrication is dropped on the LLM's say-so (spec AC, T2.3)", async () => {
    const provider = makeProvider([
      JSON.stringify({
        adjudications: [
          {
            path: "skills.devops_tools[0]",
            action: "drop",
            reason: "The excerpt never mentions Kubernetes.",
          },
        ],
      }),
    ]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);
    const profile = profileWithFabrication();

    const result = await runValidation(ai, {
      userId: "user-1",
      profile,
      flaggedItems: itemsFor(profile),
      cvText: CV_TEXT,
    });
    expect(result.profile.skills.devops_tools).toEqual([]);
    expect(result.adjudicatedCount).toBe(1);
    expect(result.meta.skipped).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage[0]).toMatchObject({ operation: "cv_profile", cache_hit: false });
  });

  it("applies corrections with verbatim evidence and recomputes is_current", async () => {
    const profile = fixtureProfile();
    const provider = makeProvider([
      JSON.stringify({
        adjudications: [
          {
            path: "roles[0].end",
            action: "correct",
            corrected: { value: "Feb 2019", evidence: "Jun 2015 - Feb 2019" },
            reason: "The role ended.",
          },
        ],
      }),
    ]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await runValidation(ai, {
      userId: "user-1",
      profile,
      flaggedItems: [
        {
          path: "roles[0].end",
          flag: MULTIPLE_CURRENT_ROLES_FLAG,
          value: "present",
          evidence: "Mar 2019 - present",
          excerpt: excerptAround(CV_TEXT, "Mar 2019 - present", "present"),
        },
      ],
      cvText: CV_TEXT,
    });
    expect(result.profile.roles[0]?.end.value).toBe("Feb 2019");
    expect(result.profile.roles[0]?.end.evidence).toBe("Jun 2015 - Feb 2019");
    expect(result.profile.roles[0]?.is_current).toBe(false);
    // The input profile is not mutated.
    expect(profile.roles[0]?.end.value).toBe("present");
  });

  it("ignores corrections whose evidence does not verify verbatim (S2 guard)", async () => {
    const profile = profileWithFabrication();
    const provider = makeProvider([
      JSON.stringify({
        adjudications: [
          {
            path: "skills.devops_tools[0]",
            action: "correct",
            corrected: { value: "Kubernetes", evidence: "managed Kubernetes at scale" },
            reason: "Hallucinated quote.",
          },
        ],
      }),
    ]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await runValidation(ai, {
      userId: "user-1",
      profile,
      flaggedItems: itemsFor(profile),
      cvText: CV_TEXT,
    });
    // Correction refused: value unchanged, still clamped by S2.
    expect(result.profile.skills.devops_tools[0]?.value).toBe("Kubernetes");
    expect(result.profile.skills.devops_tools[0]?.evidence).toBe(
      "deployed Kubernetes clusters to AWS",
    );
    expect(result.profile.skills.devops_tools[0]?.confidence).toBeLessThanOrEqual(0.4);
  });

  it("never adjudicates user-sourced facts (spec §FR-4)", async () => {
    const profile = fixtureProfile();
    profile.headline.title = {
      value: "CTO",
      status: "stated",
      confidence: 1,
      evidence: null,
      source: "user",
    };
    const provider = makeProvider([
      JSON.stringify({
        adjudications: [{ path: "headline.title", action: "drop", reason: "drop it" }],
      }),
    ]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await runValidation(ai, {
      userId: "user-1",
      profile,
      flaggedItems: [
        {
          path: "headline.title",
          flag: LOW_CONFIDENCE_FLAG,
          value: "CTO",
          evidence: null,
          excerpt: CV_TEXT.slice(0, 600),
        },
      ],
      cvText: CV_TEXT,
    });
    expect(result.profile.headline.title.value).toBe("CTO");
    expect(result.adjudicatedCount).toBe(0);
  });
});
