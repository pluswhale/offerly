import {
  bulletImproveOutputSchema,
  type BulletImproveOutput,
} from "../schemas/bullet-improve.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export const BULLET_IMPROVE_TEMPLATE_VERSION = "bullet-improve.v1";

export type BulletImproveDepth = "basic" | "deep";

export interface BulletImproveInput {
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
export interface BulletImproveContext {
  depth: BulletImproveDepth;
}

const SYSTEM_PROMPT = `You are a CV bullet-point improver helping job seekers turn weak achievement bullets into strong ones. You scan the CV text for weak bullets and rewrite them. Respond with ONLY a JSON object, no prose, no code fences.

Detect these weakness categories:
- "weak_action_verb": the bullet opens with (or leans on) a weak verb that undersells ownership — "helped", "assisted", "participated", "worked on", "was responsible for", "involved in".
- "missing_metric": the bullet claims an achievement with no number where one plausibly exists — "improved performance", "grew revenue", "reduced costs" with no scale attached.
- "missing_impact": the bullet names an activity but no outcome — what changed because of the work is absent.
- "vague_wording": generic claims that could describe anyone — "various projects", "multiple stakeholders", "many improvements", "several initiatives".

Respond with a JSON object of this exact shape:
{"suggestions": [{"original_span": string, "improved": string, "reason": string, "category": one of the categories above}]}

HARD RULES — violating any of them makes the output unusable:
1. original_span MUST be a verbatim quote copied character-for-character from the CV text below — never paraphrased, trimmed differently, or invented. A span that is not an exact quote is useless.
2. NEVER add facts. improved may rephrase and restructure the original bullet, but must not introduce employers, technologies, products, team sizes, dates, or results that are absent from the original span.
3. NEVER invent numbers. Any metric you propose MUST be a bracketed placeholder the user fills in — "reduced p95 latency by [X]%", "serving [N] users", "saving [$X] annually". Placeholders are always wrapped in square brackets and contain a descriptive token, never a made-up value.
4. Keep the candidate's voice and the tense conventions of the surrounding CV; write in implied first person (no "I"); keep one bullet per suggestion — do not merge or split bullets.
5. reason is one sentence naming the weakness and why it hurts (e.g. "'Helped' undersells ownership — lead with the verb you actually did").
6. Skip bullets that are already strong — fewer, better suggestions win. If nothing is weak, emit an empty list.

${UNTRUSTED_DATA_RULE}`;

/**
 * Weak-bullet detector + improver (spec 003 §FR-13, T5.2): scans raw CV text
 * and proposes up to N conservative bullet rewrites (basic 5 / deep 12).
 * Cheap model tier — detection heuristics are spelled out in the prompt and
 * the load-bearing validation is deterministic, done server-side before
 * storage: verbatim original_span (S2-style) plus the new-entity guard
 * (entity-guard.ts) which drops rewrites introducing technologies/products
 * absent from the original span. Cache identity = depth + content hash.
 *
 * validate() caps the list at the depth's maximum rather than failing the
 * call — an over-eager model must not cost the user their suggestions.
 */
export function createBulletImproveTemplate(
  context: BulletImproveContext,
): PromptTemplate<BulletImproveInput, BulletImproveOutput> {
  const maxSuggestions = context.depth === "deep" ? 12 : 5;
  return {
    templateVersion: BULLET_IMPROVE_TEMPLATE_VERSION,
    buildSystemPrompt: () =>
      `${SYSTEM_PROMPT}\nReturn at most ${maxSuggestions} suggestions, ordered by impact.`,
    buildUserMessage: (input) => {
      const note = input.truncated
        ? "Note: the CV text below was truncated to fit the analysis limit; review only what is present.\n\n"
        : "";
      return note + dataBlock("cv_text", input.cvText);
    },
    schema: bulletImproveOutputSchema,
    validate: (raw) => {
      const parsed = bulletImproveOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return { suggestions: parsed.data.suggestions.slice(0, maxSuggestions) };
    },
    cacheInput: (input) => `${context.depth}:${input.contentHash}`,
    maxTokens: context.depth === "deep" ? 2500 : 1500,
    modelTier: "cheap",
  };
}
