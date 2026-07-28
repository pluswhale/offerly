import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
} from "./llm-provider.js";
import { LlmProviderError } from "./llm-provider.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * OpenAI-compatible chat-completions provider (plan §8.1).
 * Base URL and model come from env so any compatible provider
 * (OpenAI, Groq, Together, local vLLM…) is a config swap, not a refactor.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get doFetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const res = await this.doFetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LlmProviderError(
        `LLM provider returned ${res.status}: ${detail.slice(0, 200)}`,
        res.status,
      );
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmProviderError("LLM provider returned no content", null);
    }
    return {
      content,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const res = await this.doFetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new LlmProviderError(
        `LLM provider returned ${res.status}: ${detail.slice(0, 200)}`,
        res.status,
      );
    }

    // Parse SSE frames: lines of `data: {json}` terminated by `data: [DONE]`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Partial JSON frame — skip; stream continues.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
