import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/modules/ai/ai.service.js";
import { LlmProviderError, type LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  buildCvAnalysisPrompt,
  parseCvAnalysisResult,
} from "../src/modules/ai/prompts/cv-analysis.v1.js";
import { SupabaseService } from "../src/modules/supabase/supabase.service.js";

const VALID_ANALYSIS = {
  score: 72,
  sections: [{ name: "Experience", score: 80, feedback: "Solid" }],
  improvements: ["Add metrics"],
};

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
  return { supabase, cache, usage };
}

const PROMPT = buildCvAnalysisPrompt({ cvText: "John Doe, engineer...", depth: "basic" });
const OPTS = {
  userId: "user-1",
  operation: "cv_analysis" as const,
  prompt: PROMPT,
  maxTokens: 1500,
  parse: parseCvAnalysisResult,
};

describe("AiService cache behavior (T5.2)", () => {
  it("miss → provider call + usage row; identical repeat → cache hit, no provider call, cache_hit logged", async () => {
    const provider = makeProvider([JSON.stringify(VALID_ANALYSIS)]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const first = await ai.generateJson(OPTS);
    expect(first.cacheHit).toBe(false);
    expect(first.data.score).toBe(72);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(first.tokensIn).toBe(100);

    const second = await ai.generateJson(OPTS);
    expect(second.cacheHit).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(provider.complete).toHaveBeenCalledTimes(1); // no second provider call

    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ cache_hit: false, tokens_in: 100, tokens_out: 50 });
    expect(usage[0]?.cost_microcents).toBeGreaterThan(0);
    expect(usage[1]).toMatchObject({ cache_hit: true, tokens_in: 0, tokens_out: 0 });
  });

  it("whitespace/case differences in input still hit the same cache key", async () => {
    const provider = makeProvider([JSON.stringify(VALID_ANALYSIS)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await ai.generateJson(OPTS);
    const messy = buildCvAnalysisPrompt({ cvText: "john   DOE,\n\nengineer...", depth: "basic" });
    const second = await ai.generateJson({ ...OPTS, prompt: messy });
    expect(second.cacheHit).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("retries once on parse failure, then succeeds", async () => {
    const provider = makeProvider(["not json at all", JSON.stringify(VALID_ANALYSIS)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await ai.generateJson(OPTS);
    expect(result.data.score).toBe(72);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    // The retry includes the repair instruction.
    const secondCall = vi.mocked(provider.complete).mock.calls[1]?.[0];
    expect(secondCall?.messages.at(-1)?.content).toContain("not valid JSON");
  });

  it("gives a clear 503 after two unparseable responses", async () => {
    const provider = makeProvider(["garbage", "still garbage"]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await expect(ai.generateJson(OPTS)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("extracts JSON from code fences", async () => {
    const provider = makeProvider(["```json\n" + JSON.stringify(VALID_ANALYSIS) + "\n```"]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await ai.generateJson(OPTS);
    expect(result.data.score).toBe(72);
  });

  it("provider failure degrades to 503, not a crash", async () => {
    const provider = makeProvider([new LlmProviderError("invalid api key", 401)]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await expect(ai.generateJson(OPTS)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("backs off and retries on 429", async () => {
    vi.useFakeTimers();
    try {
      const provider = makeProvider([
        new LlmProviderError("rate limited", 429),
        new LlmProviderError("rate limited", 429),
        JSON.stringify(VALID_ANALYSIS),
      ]);
      const { supabase } = makeSupabase();
      const ai = new AiService(supabase, provider);

      const pending = ai.generateJson(OPTS);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.data.score).toBe(72);
      expect(provider.complete).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
