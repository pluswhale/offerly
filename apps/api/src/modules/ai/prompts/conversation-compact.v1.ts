import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export interface CompactionInput {
  /** Older chat turns rendered as "role: content" lines by the caller. */
  turnsText: string;
}

/**
 * History summarization (spec 003 §FR-10). Free-text output, uncached
 * (per-conversation), driven via AiService.completeText.
 */
export const conversationCompactV1: PromptTemplate<CompactionInput, string> = {
  templateVersion: "conversation-compact.v1",
  buildSystemPrompt: () =>
    "Summarize this career-coaching conversation excerpt into at most 6 bullet points " +
    "capturing the user's situation, decisions made, and advice given. Plain text bullets only. " +
    UNTRUSTED_DATA_RULE,
  buildUserMessage: (input) => dataBlock("conversation", input.turnsText),
  // Plain-text output: no JSON schema; validation just guards against empty summaries.
  validate: (raw) => (typeof raw === "string" && raw.trim().length > 0 ? raw : null),
  cacheInput: (input) => input.turnsText,
  maxTokens: 400,
  modelTier: "cheap",
};
