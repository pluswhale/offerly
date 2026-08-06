import { z } from "zod";

/**
 * recommendations.v1 output mirror (spec 003 §FR-10, T4.2): 2–4 prioritized
 * next actions grounded in the match report's actual verdicts.
 * requirement_refs must cite requirement ids from the report — the template's
 * validate() strips refs that do not (a hint, never load-bearing).
 */

export const recommendationSchema = z.object({
  /** 1 = highest impact. */
  priority: z.number().int().min(1),
  action: z.string().min(1),
  rationale: z.string().min(1),
  /** Requirement ids from the report's verdicts this action addresses. */
  requirement_refs: z.array(z.string()).default([]),
});

export const recommendationsOutputSchema = z.object({
  recommendations: z.array(recommendationSchema).min(2).max(4),
});

export type RecommendationsOutput = z.infer<typeof recommendationsOutputSchema>;
