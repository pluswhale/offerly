import { z } from "zod";
import { requirementVerdictSchema } from "./match-report.schema.js";

/** match-requirements.v1 output mirror (spec 003 §FR-7/§FR-10, T3.3). */

export const matchRequirementsOutputSchema = z.object({
  /** Exactly one verdict per input requirement — enforced by the template's validate(). */
  verdicts: z.array(requirementVerdictSchema),
});

export type MatchRequirementsOutput = z.infer<typeof matchRequirementsOutputSchema>;
