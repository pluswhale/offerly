import { z } from "zod";

/**
 * bullet-improve.v1 output mirror (spec 003 §FR-13/§FR-10, T5.2).
 *
 * Achievement-bullet detection + rewrite over raw CV text: each suggestion
 * quotes the weak bullet verbatim (the UI locates it by exact match), rewrites
 * it conservatively — rephrase/restructure only, never new facts — and classifies
 * the weakness. Metrics the model proposes are ALWAYS bracketed placeholders
 * ("by [X]%", "serving [N] users") the user fills in; the honesty rule forbids
 * invented numbers, and the server-side new-entity guard (entity-guard.ts)
 * drops rewrites naming technologies/products absent from the original span.
 * Per-item `id`/`status` are NOT model output — they are assigned server-side
 * at storage time (see cv-improvements.service.ts).
 */

export const bulletImproveCategorySchema = z.enum([
  "weak_action_verb",
  "missing_metric",
  "missing_impact",
  "vague_wording",
]);

export type BulletImproveCategory = z.infer<typeof bulletImproveCategorySchema>;

export const bulletImproveSuggestionSchema = z.object({
  /** Verbatim quote from the CV — verified against the source text before storage. */
  original_span: z.string().min(1),
  improved: z.string().min(1),
  reason: z.string().min(1),
  category: bulletImproveCategorySchema,
});

export type BulletImproveSuggestion = z.infer<typeof bulletImproveSuggestionSchema>;

export const bulletImproveOutputSchema = z.object({
  suggestions: z.array(bulletImproveSuggestionSchema),
});

export type BulletImproveOutput = z.infer<typeof bulletImproveOutputSchema>;
