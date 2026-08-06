import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { conversationCompactV1 } from "../src/modules/ai/prompts/conversation-compact.v1.js";
import {
  buildPrompt,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "../src/modules/ai/prompts/prompt.types.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";

function makeSupabase() {
  const cache = new Map<string, unknown>();
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
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase: { getServiceClient: () => client } as unknown as SupabaseService, cache };
}

const echoSchema = z.object({ echo: z.string() });

const echoTemplate: PromptTemplate<{ text: string }, { echo: string }> = {
  templateVersion: "test-echo.v1",
  buildSystemPrompt: () => `Echo back. ${UNTRUSTED_DATA_RULE}`,
  buildUserMessage: (input) => input.text,
  schema: echoSchema,
  validate: (raw) => {
    const parsed = echoSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  cacheInput: (input) => input.text,
  maxTokens: 123,
  modelTier: "cheap",
};

describe("prompt template contract (spec 003 §FR-10, T1.4)", () => {
  it("buildPrompt assembles version + cache input + system/user messages", () => {
    const prompt = buildPrompt(echoTemplate, { text: "hello" });
    expect(prompt.templateVersion).toBe("test-echo.v1");
    expect(prompt.cacheInput).toBe("hello");
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]?.role).toBe("system");
    expect(prompt.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("conversation-compact.v1 keeps its persona rules and data block", () => {
    const prompt = buildPrompt(conversationCompactV1, { turnsText: "user: hi" });
    expect(prompt.templateVersion).toBe("conversation-compact.v1");
    expect(prompt.messages[0]?.content).toContain("untrusted user-provided data");
    expect(prompt.messages[0]?.content).not.toContain("user: hi");
    expect(prompt.messages[1]?.content).toBe("<conversation>\nuser: hi\n</conversation>");
    expect(conversationCompactV1.validate("summary")).toBe("summary");
    expect(conversationCompactV1.validate("   ")).toBeNull();
    expect(conversationCompactV1.validate(42)).toBeNull();
  });

  it("cache keys include templateVersion: same input, different version → different key", () => {
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, { complete: vi.fn(), stream: vi.fn() });
    const v1 = buildPrompt(echoTemplate, { text: "same input" });
    const v2 = { ...v1, templateVersion: "test-echo.v2" };
    expect(ai.cacheKey(v1)).not.toBe(ai.cacheKey(v2));
    // Same version + input → stable key.
    expect(ai.cacheKey(v1)).toBe(ai.cacheKey(buildPrompt(echoTemplate, { text: "same input" })));
  });

  it("generateFromTemplate drives the gateway with the template's maxTokens and validate", async () => {
    const provider: LlmProvider = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ echo: "hi" }),
        tokensIn: 10,
        tokensOut: 5,
      })),
      stream: vi.fn(),
    };
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await ai.generateFromTemplate({
      userId: "user-1",
      operation: "coach_message",
      template: echoTemplate,
      input: { text: "hi" },
    });
    expect(result.data).toEqual({ echo: "hi" });
    expect(vi.mocked(provider.complete).mock.calls[0]?.[0].maxTokens).toBe(123);
  });

  it("LLM_MODEL__<TEMPLATE_NAME> env override routes the template to another model", async () => {
    const provider: LlmProvider = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ echo: "hi" }),
        tokensIn: 10,
        tokensOut: 5,
      })),
      stream: vi.fn(),
    };
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    process.env.LLM_MODEL__TEST_ECHO_V1 = "stronger-model";
    try {
      await ai.generateFromTemplate({
        userId: "user-1",
        operation: "coach_message",
        template: echoTemplate,
        input: { text: "hi" },
      });
      expect(vi.mocked(provider.complete).mock.calls[0]?.[0].model).toBe("stronger-model");
    } finally {
      delete process.env.LLM_MODEL__TEST_ECHO_V1;
    }
  });
});
