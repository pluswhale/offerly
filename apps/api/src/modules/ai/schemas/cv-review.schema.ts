import { z } from "zod";

/**
 * cv-review.v2 output mirror (spec 003 §FR-9/§FR-10, T4.1).
 *
 * The shape is the frontend's existing `CvAnalysis.result` contract
 * (apps/web/lib/contract.ts): {score, sections, improvements} — improvements
 * are the {priority, title, detail} objects the UI already renders, with an
 * additive optional field_ref citing the profile field the improvement
 * concerns. Old UI versions ignore field_ref; old stored rows (v1, string
 * improvements) stay readable — the UI feature-detects nothing new here.
 */

export const cvReviewSectionSchema = z.object({
  name: z.string().min(1),
  score: z.number().min(0).max(100),
  feedback: z.string().min(1),
});

export const cvReviewImprovementSchema = z.object({
  /** 1 = most impactful. */
  priority: z.number().int().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  /**
   * Profile field path this improvement concerns (e.g. "headline.title",
   * "skills.devops_tools[0]"). Optional and additive; the template's
   * validate() strips refs that do not resolve in the Candidate Profile.
   */
  field_ref: z.string().optional(),
});

export const cvReviewOutputSchema = z.object({
  score: z.number().min(0).max(100),
  sections: z.array(cvReviewSectionSchema),
  improvements: z.array(cvReviewImprovementSchema),
});

export type CvReviewOutput = z.infer<typeof cvReviewOutputSchema>;
