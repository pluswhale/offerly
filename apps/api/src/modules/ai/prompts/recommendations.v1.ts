import type { MatchReportV2 } from "@offerly/types";
import {
  recommendationsOutputSchema,
  type RecommendationsOutput,
} from "../schemas/recommendations.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export const RECOMMENDATIONS_TEMPLATE_VERSION = "recommendations.v1";

export interface RecommendationsInput {
  /** The freshly computed match report v2 — verdicts carry the grounding. */
  report: MatchReportV2;
  /** Cache identity parts (spec §FR-10): the report's reuse key. */
  profileContentHash: string;
  jobContentHash: string;
}

/**
 * Validation context (never sent to the model): requirement_refs are checked
 * against the report's requirement ids.
 */
export interface RecommendationsContext {
  requirementIds: readonly string[];
}

const SYSTEM_PROMPT = `You turn a job-match report into the candidate's next actions. You receive the report: an explainable score with a per-component breakdown and one verdict per job requirement ("match" | "partial" | "unknown" | "missing", with grounded reasoning). Respond with ONLY a JSON object, no prose, no code fences.

Respond with a JSON object of this exact shape:
{"recommendations": [{"priority": <int, 1 = highest impact>, "action": string, "rationale": string, "requirement_refs": [requirement ids]}]}

HARD RULES — violating any of them makes the output unusable:
1. Emit 2-4 recommendations, ordered by impact on THIS job's score.
2. Every action must be grounded in the actual verdicts — reference the requirement it addresses via requirement_refs (ids exactly as given) and say why in one sentence of rationale. No generic CV advice ("use action verbs", "keep it to one page") that ignores the report.
3. "missing" and "partial" must-haves are fix-it actions (what to add or strengthen, concretely). "unknown" must-haves are clarification actions ("your CV doesn't mention X — if you have it, add it"); never claim the candidate lacks an "unknown" requirement.
4. When low_confidence is true, the first recommendation is completing the profile so the score can be trusted.
5. Never invent skills, experience, or facts about the candidate.

${UNTRUSTED_DATA_RULE}`;

/**
 * Next-action advice from a match report (spec 003 §FR-10, T4.2). Computed
 * once per fresh report and stored on it; cached per report hash
 * (profile_content_hash + job_content_hash + weights_version) so the reuse
 * path and re-renders cost zero tokens.
 *
 * validate() strips requirement_refs that cite ids absent from the report
 * (a hint, never load-bearing — same policy as cv-review.v2's field_ref).
 */
export function createRecommendationsTemplate(
  context: RecommendationsContext,
): PromptTemplate<RecommendationsInput, RecommendationsOutput> {
  return {
    templateVersion: RECOMMENDATIONS_TEMPLATE_VERSION,
    buildSystemPrompt: () => SYSTEM_PROMPT,
    buildUserMessage: (input) =>
      `Give the candidate their next actions for this match report.\n\n${dataBlock(
        "match_report",
        JSON.stringify(input.report, null, 2),
      )}`,
    schema: recommendationsOutputSchema,
    validate: (raw) => {
      const parsed = recommendationsOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      const known = new Set(context.requirementIds);
      for (const recommendation of parsed.data.recommendations) {
        recommendation.requirement_refs = recommendation.requirement_refs.filter((ref) =>
          known.has(ref),
        );
      }
      return parsed.data;
    },
    cacheInput: (input) =>
      `${input.profileContentHash}:${input.jobContentHash}:${input.report.weights_version}`,
    maxTokens: 1024,
    modelTier: "cheap",
  };
}
