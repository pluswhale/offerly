import {
  sentenceRewriteOutputSchema,
  type SentenceRewriteOutput,
} from "../schemas/sentence-rewrite.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export const SENTENCE_REWRITE_TEMPLATE_VERSION = "sentence-rewrite.v1";

export type SentenceRewriteDepth = "basic" | "deep";

export interface SentenceRewriteInput {
  /** CV text, already truncated by the caller. */
  cvText: string;
  /** CV content hash — part of the cache identity (spec §FR-10: content_hash). */
  contentHash: string;
  /** True when the CV exceeded the input cap and was truncated. */
  truncated: boolean;
}

/**
 * Validation context (never sent to the model): the depth fixes the maximum
 * suggestion count + token cap (free=basic / pro=deep, same split as review).
 */
export interface SentenceRewriteContext {
  depth: SentenceRewriteDepth;
}

const SYSTEM_PROMPT = `You are a CV sentence rewriter helping job seekers strengthen their resume. You scan the CV text for weak sentences and rewrite them. Respond with ONLY a JSON object, no prose, no code fences.

Detect these weakness categories:
- "vague_responsibility": passive duty statements that hide ownership — "responsible for…", "worked on…", "duties included…", "involved in…", "helped with…".
- "missing_action_verb": the sentence has no strong action verb carrying it.
- "missing_outcome": an activity with no result — what changed because of the work is absent.
- "first_person": first-person narration ("I led…", "my team…", "we built…") — CVs use implied first person.
- "paragraph_should_be_bullets": a prose paragraph listing several achievements that belongs in bullet points.
- "filler_words": filler adverbs and intensifiers that add no information ("very", "successfully", "really", "various").
- "overlong_sentence": a sentence over 40 words that should be split or tightened.

Respond with a JSON object of this exact shape:
{"suggestions": [{"original_span": string, "improved": string, "reason": string, "category": one of the categories above}]}

HARD RULES — violating any of them makes the output unusable:
1. original_span MUST be a verbatim quote copied character-for-character from the CV text below — never paraphrased, trimmed differently, or invented. A span that is not an exact quote is useless.
2. improved must fix ONLY the weakness named in reason. Never add facts, employers, technologies, or metrics that are absent from the original span — rephrase and restructure only.
3. Keep the candidate's voice and the tense conventions of the surrounding CV; write in implied first person (no "I").
4. reason is one sentence naming the weakness and why it hurts (e.g. "'Responsible for' is a duty statement that hides ownership").
5. Skip sentences that are already strong — fewer, better suggestions win. If nothing is weak, emit an empty list.

${UNTRUSTED_DATA_RULE}`;

/**
 * Weak-sentence detector + rewriter (spec 003 §FR-12, T5.1): scans raw CV
 * text and proposes up to N conservative rewrites (basic 5 / deep 12).
 * Cheap model tier — detection heuristics are spelled out in the prompt and
 * the load-bearing validation (verbatim original_span) is deterministic,
 * done server-side before storage. Cache identity = depth + content hash.
 *
 * validate() caps the list at the depth's maximum rather than failing the
 * call — an over-eager model must not cost the user their suggestions.
 */
export function createSentenceRewriteTemplate(
  context: SentenceRewriteContext,
): PromptTemplate<SentenceRewriteInput, SentenceRewriteOutput> {
  const maxSuggestions = context.depth === "deep" ? 12 : 5;
  return {
    templateVersion: SENTENCE_REWRITE_TEMPLATE_VERSION,
    buildSystemPrompt: () =>
      `${SYSTEM_PROMPT}\nReturn at most ${maxSuggestions} suggestions, ordered by impact.`,
    buildUserMessage: (input) => {
      const note = input.truncated
        ? "Note: the CV text below was truncated to fit the analysis limit; review only what is present.\n\n"
        : "";
      return note + dataBlock("cv_text", input.cvText);
    },
    schema: sentenceRewriteOutputSchema,
    validate: (raw) => {
      const parsed = sentenceRewriteOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return { suggestions: parsed.data.suggestions.slice(0, maxSuggestions) };
    },
    cacheInput: (input) => `${context.depth}:${input.contentHash}`,
    maxTokens: context.depth === "deep" ? 2500 : 1500,
    modelTier: "cheap",
  };
}
