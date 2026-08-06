import { z } from "zod";

/** cv-validate.v1 output mirror (spec 003 §FR-1 S3, T2.3). */

export const adjudicationActionSchema = z.enum(["keep", "correct", "drop"]);

export const adjudicationSchema = z
  .object({
    /** Verifier-style field path of the adjudicated item, echoed back. */
    path: z.string().min(1),
    action: adjudicationActionSchema,
    /** Required for 'correct': the fixed value + a verbatim quote from the excerpt. */
    corrected: z
      .object({
        value: z.unknown(),
        evidence: z.string().min(1),
      })
      .optional(),
    /** One sentence, grounded in the excerpt. */
    reason: z.string().min(1),
  })
  .superRefine((raw, ctx) => {
    if (raw.action === "correct" && !raw.corrected) {
      ctx.addIssue({
        code: "custom",
        path: ["corrected"],
        message: "action 'correct' requires a corrected value + evidence",
      });
    }
  });

export const cvValidateOutputSchema = z.object({
  adjudications: z.array(adjudicationSchema),
});

export type CvValidateAdjudication = z.infer<typeof adjudicationSchema>;
export type CvValidateOutput = z.infer<typeof cvValidateOutputSchema>;
