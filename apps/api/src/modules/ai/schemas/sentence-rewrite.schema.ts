import { z } from "zod";

/**
 * sentence-rewrite.v1 output mirror (spec 003 §FR-12/§FR-10, T5.1).
 *
 * Weak-sentence detection + rewrite over raw CV text: each suggestion quotes
 * the weak span verbatim (the UI locates it by exact match), rewrites it
 * conservatively (no new facts — metric placeholders belong to the bullet
 * task, T5.2), names the weakness in `reason`, and classifies it. Per-item
 * `id`/`status` are NOT model output — they are assigned server-side at
 * storage time (see cv-improvements.service.ts).
 */

export const sentenceRewriteCategorySchema = z.enum([
  "vague_responsibility",
  "missing_action_verb",
  "missing_outcome",
  "first_person",
  "paragraph_should_be_bullets",
  "filler_words",
  "overlong_sentence",
]);

export type SentenceRewriteCategory = z.infer<typeof sentenceRewriteCategorySchema>;

export const sentenceRewriteSuggestionSchema = z.object({
  /** Verbatim quote from the CV — verified against the source text before storage. */
  original_span: z.string().min(1),
  improved: z.string().min(1),
  reason: z.string().min(1),
  category: sentenceRewriteCategorySchema,
});

export type SentenceRewriteSuggestion = z.infer<typeof sentenceRewriteSuggestionSchema>;

export const sentenceRewriteOutputSchema = z.object({
  suggestions: z.array(sentenceRewriteSuggestionSchema),
});

export type SentenceRewriteOutput = z.infer<typeof sentenceRewriteOutputSchema>;
