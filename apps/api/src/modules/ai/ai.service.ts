import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { UsageOperation } from "@offerly/types";
import { env } from "../../common/env.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { ConcurrencyLimiter } from "./concurrency.js";
import {
  LLM_PROVIDER,
  LlmProviderError,
  type ChatMessage,
  type LlmProvider,
} from "./llm-provider.js";
import type { BuiltPrompt } from "./prompts/prompt.types.js";
import { estimateTokens, normalizeForCache, sha256Hex } from "./text.js";

/** microcents (1e-6 of a US cent) per 1M tokens, keyed by model. */
const MODEL_PRICING_MICROCENTS_PER_1M: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 15_000_000, out: 60_000_000 }, // $0.15 / $0.60 per 1M
};
const DEFAULT_PRICING = { in: 15_000_000, out: 60_000_000 };

export interface GenerateJsonOptions<T> {
  userId: string;
  operation: UsageOperation;
  prompt: BuiltPrompt;
  maxTokens: number;
  /** Validates parsed JSON; return null to trigger one retry. */
  parse: (raw: unknown) => T | null;
  /** Skip cache lookup+store (e.g. one-off regenerations are still cached by default). */
  skipCache?: boolean;
}

export interface GenerateJsonResult<T> {
  data: T;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The single LLM gateway (T5.2, plan §8). Every LLM call in the app goes
 * through here: cache-before-call, token caps, retry-once-on-parse-failure,
 * concurrency limit + 429 backoff, usage_records logging with cost estimate.
 */
@Injectable()
export class AiService {
  private readonly model = env("LLM_MODEL", "gpt-4o-mini");
  private readonly limiter = new ConcurrencyLimiter(
    Number(env("LLM_MAX_CONCURRENCY", "4")),
  );

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
  ) {}

  cacheKey(prompt: BuiltPrompt): string {
    return sha256Hex(`${prompt.templateVersion}:${normalizeForCache(prompt.cacheInput)}`);
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<GenerateJsonResult<T>> {
    const key = this.cacheKey(opts.prompt);

    if (!opts.skipCache) {
      const cached = await this.cacheLookup(key);
      if (cached !== null) {
        const parsed = opts.parse(cached);
        if (parsed !== null) {
          // Cache hits are logged but do NOT consume quota (plan §8.3).
          await this.logUsage(opts.userId, opts.operation, 0, 0, true);
          return { data: parsed, cacheHit: true, tokensIn: 0, tokensOut: 0 };
        }
      }
    }

    const result = await this.callWithRetryAndParse(opts);
    await this.logUsage(opts.userId, opts.operation, result.tokensIn, result.tokensOut, false);
    if (!opts.skipCache) {
      await this.cacheStore(key, result.data);
    }
    return { ...result, cacheHit: false };
  }

  /** Non-JSON completion (e.g. conversation compaction). Not cached. */
  async completeText(opts: {
    userId: string;
    operation: UsageOperation;
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<string> {
    const result = await this.callWithBackoff(opts.messages, opts.maxTokens, false);
    await this.logUsage(opts.userId, opts.operation, result.tokensIn, result.tokensOut, false);
    return result.content;
  }

  /**
   * Streaming completion for coach SSE. Usage is logged when the stream
   * completes (token estimate, since stream usage isn't returned by all providers).
   */
  async *streamText(opts: {
    userId: string;
    operation: UsageOperation;
    messages: ChatMessage[];
    maxTokens: number;
  }): AsyncIterable<string> {
    let full = "";
    try {
      const stream = await this.limiter.run(() =>
        Promise.resolve(
          this.provider.stream({
            model: this.model,
            messages: opts.messages,
            maxTokens: opts.maxTokens,
          }),
        ),
      );
      for await (const delta of stream) {
        full += delta;
        yield delta;
      }
    } catch (err) {
      throw this.toUnavailable(err);
    }
    const inText = opts.messages.map((m) => m.content).join("\n");
    await this.logUsage(
      opts.userId,
      opts.operation,
      estimateTokens(inText),
      estimateTokens(full),
      false,
    );
  }

  private async callWithRetryAndParse<T>(
    opts: GenerateJsonOptions<T>,
  ): Promise<{ data: T; tokensIn: number; tokensOut: number }> {
    const messages = [...opts.prompt.messages];
    let tokensIn = 0;
    let tokensOut = 0;

    // One retry on parse/validation failure (plan §8.4).
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.callWithBackoff(messages, opts.maxTokens, true);
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      const data = opts.parse(extractJson(res.content));
      if (data !== null) {
        return { data, tokensIn, tokensOut };
      }
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content:
          "That was not valid JSON in the required shape. Respond with ONLY the JSON object, no prose, no code fences.",
      });
    }
    throw new ServiceUnavailableException(
      "AI provider returned an unparseable response; please try again",
    );
  }

  /** Concurrency-limited call with exponential backoff on 429/5xx (plan §8.5). */
  private async callWithBackoff(
    messages: ChatMessage[],
    maxTokens: number,
    json: boolean,
  ): Promise<{ content: string; tokensIn: number; tokensOut: number }> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.limiter.run(() =>
          this.provider.complete({ model: this.model, messages, maxTokens, json }),
        );
      } catch (err) {
        const retryable =
          err instanceof LlmProviderError &&
          err.status !== null &&
          (err.status === 429 || err.status >= 500);
        if (!retryable || attempt === MAX_ATTEMPTS - 1) {
          throw this.toUnavailable(err);
        }
        await sleep(500 * 2 ** attempt);
      }
    }
    throw this.toUnavailable(new Error("unreachable"));
  }

  /** Graceful degradation: provider failure surfaces as a clear 503, not a crash. */
  private toUnavailable(err: unknown): ServiceUnavailableException {
    if (err instanceof ServiceUnavailableException) return err;
    // Provider detail (raw JSON bodies, quota messages) stays server-side —
    // clients get the status class only (constitution §III: never leak internals).
    const status = err instanceof LlmProviderError ? err.status : null;
    const reason =
      status === 429
        ? "provider rate/quota limit reached"
        : status !== null
          ? `provider error ${status}`
          : "provider unreachable";
    return new ServiceUnavailableException(
      `AI provider unavailable — please try again later (${reason})`,
    );
  }

  private async cacheLookup(key: string): Promise<unknown | null> {
    const { data, error } = await this.supabase
      .getServiceClient()
      .from("llm_cache")
      .select("response")
      .eq("cache_key", key)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { response: unknown }).response;
  }

  private async cacheStore(key: string, response: unknown): Promise<void> {
    await this.supabase
      .getServiceClient()
      .from("llm_cache")
      .upsert({ cache_key: key, response: response as Record<string, unknown> });
  }

  private async logUsage(
    userId: string,
    operation: UsageOperation,
    tokensIn: number,
    tokensOut: number,
    cacheHit: boolean,
  ): Promise<void> {
    const pricing = MODEL_PRICING_MICROCENTS_PER_1M[this.model] ?? DEFAULT_PRICING;
    const cost = Math.round(
      (tokensIn * pricing.in + tokensOut * pricing.out) / 1_000_000,
    );
    await this.supabase.getServiceClient().from("usage_records").insert({
      user_id: userId,
      operation,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_microcents: cost,
      cache_hit: cacheHit,
    });
  }
}

function extractJson(content: string): unknown {
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence?.[1]) text = fence[1];
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
