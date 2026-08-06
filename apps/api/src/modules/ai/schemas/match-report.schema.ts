import { z } from "zod";

/** RequirementVerdict / ScoreBreakdown / MatchReportV2 mirror (spec 003 §FR-7/§FR-8). */

export const verdictValueSchema = z.enum(["match", "partial", "unknown", "missing"]);

export const requirementVerdictSchema = z.object({
  requirement_id: z.string().min(1),
  verdict: verdictValueSchema,
  confidence: z.number().min(0).max(1),
  candidate_evidence: z.array(z.string()),
  reasoning: z.string(),
});

export const componentScoreSchema = z.object({
  weight: z.number().min(0).max(1),
  component_score: z.number().min(0).max(1),
  contribution: z.number(),
});

export const scoreBreakdownSchema = z.object({
  must_have: componentScoreSchema,
  nice_to_have: componentScoreSchema,
  experience: componentScoreSchema,
  industry: componentScoreSchema,
  location_remote: componentScoreSchema,
  languages: componentScoreSchema,
  education: componentScoreSchema,
});

export const matchReportV2Schema = z.object({
  version: z.literal(2),
  score: z.number().min(0).max(100),
  weights_version: z.string().min(1),
  breakdown: scoreBreakdownSchema,
  verdicts: z.array(requirementVerdictSchema),
  low_confidence: z.boolean(),
  unknown_must_have_share: z.number().min(0).max(1),
  template_versions: z.record(z.string(), z.string()),
});
