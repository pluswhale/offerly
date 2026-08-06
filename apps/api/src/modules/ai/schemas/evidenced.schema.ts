import { z } from "zod";

export const evidencedStatusSchema = z.enum(["stated", "unknown", "contradicted"]);
export const factSourceSchema = z.enum(["ai", "user"]);

interface EvidencedShape<V> {
  value: V | null;
  status: z.infer<typeof evidencedStatusSchema>;
  confidence: number;
  evidence: string | null;
  source?: z.infer<typeof factSourceSchema>;
}

/**
 * Evidenced<T> mirror (spec 003 §FR-2) with the cross-field invariants:
 * - 'stated'   → non-null value, and non-null evidence unless the fact is a
 *                user correction (source: 'user', spec §FR-4 — user statements
 *                need no evidence)
 * - 'unknown'  → null value AND null evidence (silence is explicit, never omission)
 * - 'contradicted' → no extra constraint (S3 output; value may or may not be set)
 */
export function evidencedSchema<V>(valueSchema: z.ZodType<V>) {
  return z
    .object({
      value: valueSchema.nullable(),
      status: evidencedStatusSchema,
      confidence: z.number().min(0).max(1),
      evidence: z.string().nullable(),
      source: factSourceSchema.optional(),
    })
    // The generic value schema defeats zod's output-type inference here, so
    // the refinement reads the shape through an explicit view.
    .superRefine((raw, ctx) => {
      const e = raw as EvidencedShape<V>;
      if (e.status === "stated") {
        if (e.value === null) {
          ctx.addIssue({
            code: "custom",
            path: ["value"],
            message: "status 'stated' requires a non-null value",
          });
        }
        if (e.evidence === null && e.source !== "user") {
          ctx.addIssue({
            code: "custom",
            path: ["evidence"],
            message: "status 'stated' requires a verbatim evidence quote (unless source is 'user')",
          });
        }
      }
      if (e.status === "unknown") {
        if (e.value !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["value"],
            message: "status 'unknown' requires a null value",
          });
        }
        if (e.evidence !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence"],
            message: "status 'unknown' requires null evidence",
          });
        }
      }
    });
}
