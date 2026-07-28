/** LLM provider abstraction (plan §8.1). The ai module is the single gateway —
 *  no other module may call a provider directly. */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Ask the provider for JSON output (OpenAI response_format). */
  json?: boolean;
}

export interface CompletionResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<string>;
}

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

/** Provider failure carrying the HTTP status so the gateway can retry 429/5xx. */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}
