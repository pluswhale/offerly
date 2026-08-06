import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  CV_EXTRACT_MAX_CHARS,
  extractCandidateProfile,
} from "../src/modules/ai/profile-extraction.js";
import { cvExtractV1 } from "../src/modules/ai/prompts/cv-extract.v1.js";
import { buildPrompt } from "../src/modules/ai/prompts/prompt.types.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import {
  CV_CONTENT_HASH,
  CV_EXTRACT_RESPONSE,
  CV_TEXT,
  fixtureProfile,
} from "./fixtures/cv-profile.fixture.js";

// Same mock style as ai.service.spec.ts: queued provider responses + in-memory
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

const OPTS = { userId: "user-1", cvText: CV_TEXT, contentHash: CV_CONTENT_HASH };

describe("cv-extract.v1 template (spec 003 §FR-2/§FR-10, T2.2)", () => {
  it("cacheInput is the CV content hash, not the text", () => {
    const prompt = buildPrompt(cvExtractV1, {
      cvText: CV_TEXT,
      contentHash: CV_CONTENT_HASH,
      truncated: false,
    });
    expect(prompt.cacheInput).toBe(CV_CONTENT_HASH);
    // Same hash with different text → same cache identity.
    const other = buildPrompt(cvExtractV1, {
      cvText: "totally different text",
      contentHash: CV_CONTENT_HASH,
      truncated: false,
    });
    expect(other.cacheInput).toBe(prompt.cacheInput);
  });

  it("wraps the CV as untrusted data and keeps the injection rule", () => {
    const prompt = buildPrompt(cvExtractV1, {
      cvText: CV_TEXT,
      contentHash: CV_CONTENT_HASH,
      truncated: false,
    });
    expect(prompt.templateVersion).toBe("cv-extract.v1");
    expect(prompt.messages[0]?.content).toContain("untrusted user-provided data");
    expect(prompt.messages[0]?.content).toContain("VERBATIM");
    expect(prompt.messages[0]?.content).not.toContain(CV_TEXT);
    expect(prompt.messages[1]?.content).toBe(`<cv>\n${CV_TEXT}\n</cv>`);
  });

  it("discloses truncation in the user message", () => {
    const prompt = buildPrompt(cvExtractV1, {
      cvText: "short text",
      contentHash: "h",
      truncated: true,
    });
    expect(prompt.messages[1]?.content).toContain("truncated");
  });

  it("validate parses a schema-valid profile", () => {
    expect(cvExtractV1.validate(structuredClone(CV_EXTRACT_RESPONSE))).not.toBeNull();
  });

  it("validate rejects an omitted field (omission is a schema error, not UNKNOWN)", () => {
    const broken = structuredClone(CV_EXTRACT_RESPONSE) as Record<string, unknown>;
    delete broken.location;
    expect(cvExtractV1.validate(broken)).toBeNull();
  });

  it("validate rejects a stated item without evidence", () => {
    const broken = fixtureProfile();
    broken.headline.title.evidence = null;
    expect(cvExtractV1.validate(broken)).toBeNull();
  });
});

describe("extractCandidateProfile (S1+S2, T2.2)", () => {
  it("parses the recorded response and logs usage op cv_profile", async () => {
    const provider = makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await extractCandidateProfile(ai, OPTS);
    expect(result.profile.headline.title.value).toBe("Senior Backend Engineer");
    expect(result.meta.templateVersion).toBe("cv-extract.v1");
    expect(result.meta.cacheHit).toBe(false);
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.analyzedChars).toBe(CV_TEXT.length);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(usage[0]).toMatchObject({ operation: "cv_profile", cache_hit: false });
  });

  it("CV with no database mention yields databases: [] and no invented skills (spec AC-2)", async () => {
    const provider = makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await extractCandidateProfile(ai, OPTS);
    expect(result.profile.skills.databases).toEqual([]);
    expect(result.profile.skills.cloud_platforms).toEqual([]);
    // Every skill value is a substring of the CV — nothing invented.
    const allSkills = Object.values(result.profile.skills).flat();
    for (const skill of allSkills) {
      expect(CV_TEXT).toContain(String(skill.value));
    }
    // Golden verbatim rate (spec AC-1): nothing flagged on the fixture.
    expect(result.report.flagged).toEqual([]);
    expect(result.report.verifiedCount).toBe(result.report.totalCount);
  });

  it("a planted fabricated evidence quote is flagged and clamped by S2", async () => {
    const fabricated = fixtureProfile();
    fabricated.skills.devops_tools.push({
      value: "Kubernetes",
      status: "stated",
      confidence: 0.95,
      evidence: "deployed Kubernetes clusters to AWS",
    });
    const provider = makeProvider([JSON.stringify(fabricated)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await extractCandidateProfile(ai, OPTS);
    expect(result.report.flagged).toHaveLength(1);
    expect(result.report.flagged[0]).toMatchObject({
      path: "skills.devops_tools[0]",
      flag: "evidence_unverified",
      value: "Kubernetes",
    });
    expect(result.profile.skills.devops_tools[0]?.confidence).toBeLessThanOrEqual(0.4);
  });

  it("truncates CVs beyond ~20k chars and discloses it", async () => {
    const provider = makeProvider([JSON.stringify(CV_EXTRACT_RESPONSE)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const longCv = `${CV_TEXT}\n${"filler line\n".repeat(3000)}`;
    const result = await extractCandidateProfile(ai, {
      ...OPTS,
      cvText: longCv,
      contentHash: "fixture-cv-hash-long",
    });
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.analyzedChars).toBeLessThanOrEqual(CV_EXTRACT_MAX_CHARS + 20);
    const userMessage = vi.mocked(provider.complete).mock.calls[0]?.[0].messages.at(-1);
    expect(userMessage?.content).toContain("truncated");
  });
});
