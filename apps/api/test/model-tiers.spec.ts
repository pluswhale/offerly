import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  UNTRUSTED_DATA_RULE,
  type ModelTier,
  type PromptTemplate,
} from "../src/modules/ai/prompts/prompt.types.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";

/**
 * Per-template model tiers (spec 003 §FR-10, T6.1). Resolution precedence:
 * LLM_MODEL__<TEMPLATE_NAME> > LLM_MODEL_CHEAP/LLM_MODEL_STRONG > LLM_MODEL.
 * Cost is priced per the model actually used, with a safe fallback +
 * warn-once for models missing from the pricing table.
 */

const ENV_KEYS = [
  "LLM_MODEL",
  "LLM_MODEL_CHEAP",
  "LLM_MODEL_STRONG",
  "LLM_MODEL__TIER_TEST_CHEAP_V1",
  "LLM_MODEL__TIER_TEST_STRONG_V1",
] as const;

function makeSupabase() {
  const usage: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === "llm_cache") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
          upsert: async () => ({ error: null }),
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
  return {
    supabase: { getServiceClient: () => client } as unknown as SupabaseService,
    usage,
  };
}

function makeProvider(): LlmProvider {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ echo: "hi" }),
      tokensIn: 1000,
      tokensOut: 500,
    })),
    stream: vi.fn(),
  };
}

const echoSchema = z.object({ echo: z.string() });

function tierTemplate(version: string, tier: ModelTier): PromptTemplate<{ text: string }, { echo: string }> {
  return {
    templateVersion: version,
    buildSystemPrompt: () => `Echo back. ${UNTRUSTED_DATA_RULE}`,
    buildUserMessage: (input) => input.text,
    schema: echoSchema,
    validate: (raw) => {
      const parsed = echoSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    cacheInput: (input) => `${version}:${input.text}`,
    maxTokens: 100,
    modelTier: tier,
  };
}

const CHEAP = tierTemplate("tier-test-cheap.v1", "cheap");
const STRONG = tierTemplate("tier-test-strong.v1", "strong");

async function callModel(
  ai: AiService,
  template: PromptTemplate<{ text: string }, { echo: string }>,
): Promise<void> {
  await ai.generateFromTemplate({
    userId: "user-1",
    operation: "coach_message",
    template,
    input: { text: "hi" },
  });
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("model tier resolution (T6.1)", () => {
  it("defaults both tiers to LLM_MODEL when no tier env is set", async () => {
    process.env.LLM_MODEL = "base-model";
    const provider = makeProvider();
    const ai = new AiService(makeSupabase().supabase, provider);

    await callModel(ai, CHEAP);
    await callModel(ai, STRONG);

    const models = vi.mocked(provider.complete).mock.calls.map((c) => c[0].model);
    expect(models).toEqual(["base-model", "base-model"]);
  });

  it("LLM_MODEL_STRONG routes only strong-tier templates; cheap stays on the default", async () => {
    process.env.LLM_MODEL = "base-model";
    process.env.LLM_MODEL_STRONG = "strong-model";
    const provider = makeProvider();
    const ai = new AiService(makeSupabase().supabase, provider);

    await callModel(ai, STRONG);
    await callModel(ai, CHEAP);

    const models = vi.mocked(provider.complete).mock.calls.map((c) => c[0].model);
    expect(models).toEqual(["strong-model", "base-model"]);
  });

  it("LLM_MODEL_CHEAP routes only cheap-tier templates", async () => {
    process.env.LLM_MODEL = "base-model";
    process.env.LLM_MODEL_CHEAP = "cheap-model";
    const provider = makeProvider();
    const ai = new AiService(makeSupabase().supabase, provider);

    await callModel(ai, CHEAP);
    await callModel(ai, STRONG);

    const models = vi.mocked(provider.complete).mock.calls.map((c) => c[0].model);
    expect(models).toEqual(["cheap-model", "base-model"]);
  });

  it("per-template override beats the tier env (precedence: template > tier > default)", async () => {
    process.env.LLM_MODEL = "base-model";
    process.env.LLM_MODEL_STRONG = "strong-model";
    process.env.LLM_MODEL__TIER_TEST_STRONG_V1 = "pinned-model";
    const provider = makeProvider();
    const ai = new AiService(makeSupabase().supabase, provider);

    await callModel(ai, STRONG);

    expect(vi.mocked(provider.complete).mock.calls[0]?.[0].model).toBe("pinned-model");
  });
});

describe("per-model pricing (T6.1)", () => {
  it("prices usage by the model actually used, not the default", async () => {
    process.env.LLM_MODEL__TIER_TEST_STRONG_V1 = "gpt-4o";
    const provider = makeProvider();
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await callModel(ai, STRONG);

    // gpt-4o ($2.50/$10.00 per 1M): (1000*250e6 + 500*1e9)/1e6 = 750_000 microcents
    expect(usage[0]?.cost_microcents).toBe(750_000);
  });

  it("unknown model falls back to default pricing and warns once", async () => {
    process.env.LLM_MODEL__TIER_TEST_CHEAP_V1 = "some-unpriced-model";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const provider = makeProvider();
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await callModel(ai, CHEAP);
    // A distinct input avoids the cache and forces a second metered call.
    await ai.generateFromTemplate({
      userId: "user-1",
      operation: "coach_message",
      template: CHEAP,
      input: { text: "again" },
    });

    // Default pricing ($0.15/$0.60 per 1M): (1000*15e6 + 500*60e6)/1e6 = 45_000
    expect(usage[0]?.cost_microcents).toBe(45_000);
    expect(usage[1]?.cost_microcents).toBe(45_000);

    const pricingWarnings = warn.mock.calls.filter((args) =>
      String(args[0]).includes("some-unpriced-model"),
    );
    expect(pricingWarnings).toHaveLength(1);
  });
});
