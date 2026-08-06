import type { CandidateProfile } from "@offerly/types";
import { getEvidencedAtPath } from "../profile-paths.js";
import {
  cvReviewOutputSchema,
  type CvReviewOutput,
} from "../schemas/cv-review.schema.js";
import { sha256Hex } from "../text.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export const CV_REVIEW_TEMPLATE_VERSION = "cv-review.v2";

export type CvReviewDepth = "basic" | "deep";

export interface CvReviewInput {
  /** The validated structured profile — the primary review subject. */
  profile: CandidateProfile;
  /** CV text, already truncated by the caller (wording/formatting feedback). */
  cvText: string;
  /** CV content hash — part of the cache identity, as with cv-analysis.v1. */
  contentHash: string;
  /** True when the CV exceeded the review cap and was truncated. */
  truncated: boolean;
}

/**
 * Validation context (never sent to the model): field_ref citations are
 * checked against the full Candidate Profile, and the depth fixes the
 * improvement count + token cap (free=basic / pro=deep, unchanged from v1).
 */
export interface CvReviewContext {
  profile: CandidateProfile;
  depth: CvReviewDepth;
}

const SYSTEM_PROMPT = `You are a CV reviewer helping job seekers improve their resume. You receive two inputs: the candidate's VALIDATED STRUCTURED PROFILE — every fact carries the field path it lives at, its status, and the evidence quote it was extracted from — and the raw CV text. Respond with ONLY a JSON object, no prose, no code fences.

Base the review on the profile first: it is the validated understanding of the candidate. Use the raw CV text only for wording, structure and formatting feedback.

Respond with a JSON object of this exact shape:
{"score": <0-100 overall>, "sections": [{"name": string, "score": <0-100>, "feedback": string}], "improvements": [{"priority": <int, 1 = most impactful>, "title": string, "detail": string, "field_ref": string?}]}

HARD RULES — violating any of them makes the output unusable:
1. field_ref is OPTIONAL: set it only when an improvement concerns a specific profile field, and then it must be that field's exact path as shown in the profile (e.g. "headline.title", "skills.devops_tools[0]", "roles[1].scope"). Never invent paths; omit field_ref when no single field applies.
2. Fields with status "unknown" and empty arrays are COMPLETENESS GAPS, not confirmed absences — naming them as gaps to fill (e.g. "your profile is silent on databases") is encouraged; never state the candidate lacks them.
3. Never claim facts that appear in neither the profile nor the raw CV text.
4. Score honestly: 70+ means genuinely strong, 50 means average.

${UNTRUSTED_DATA_RULE}`;

/**
 * CV quality review re-based on the Candidate Profile (spec 003 §FR-9, T4.1):
 * the slim single-prompt consumer of the pipeline's output. The result shape
 * is the frontend's existing contract — {score, sections, improvements} with
 * {priority, title, detail} items — plus an additive optional field_ref
 * citing the profile field an improvement concerns.
 *
 * validate() strips field_refs that do not resolve to a real profile leaf
 * rather than failing the review (unlike match-requirements.v1, where
 * citations are the contract): a bogus hint must never cost the user their
 * analysis. Cache identity = depth + content hash + profile content, so user
 * corrections to the profile invalidate the cached review (spec §FR-4).
 */
export function createCvReviewTemplate(
  context: CvReviewContext,
): PromptTemplate<CvReviewInput, CvReviewOutput> {
  const improvementCount = context.depth === "deep" ? "5-8" : "3";
  return {
    templateVersion: CV_REVIEW_TEMPLATE_VERSION,
    buildSystemPrompt: () =>
      `${SYSTEM_PROMPT}\nGive exactly ${improvementCount} improvements, ordered by impact (priority 1 first).`,
    buildUserMessage: (input) => {
      const note = input.truncated
        ? "Note: the CV text below was truncated to fit the analysis limit; review only what is present.\n\n"
        : "";
      return (
        note +
        dataBlock("candidate_profile", JSON.stringify(input.profile, null, 2)) +
        "\n\n" +
        dataBlock("cv_text", input.cvText)
      );
    },
    schema: cvReviewOutputSchema,
    validate: (raw) => {
      const parsed = cvReviewOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      for (const improvement of parsed.data.improvements) {
        if (
          improvement.field_ref !== undefined &&
          getEvidencedAtPath(context.profile, improvement.field_ref) === null
        ) {
          delete improvement.field_ref;
        }
      }
      return parsed.data;
    },
    cacheInput: (input) =>
      `${context.depth}:${input.contentHash}:${sha256Hex(JSON.stringify(input.profile))}`,
    maxTokens: context.depth === "deep" ? 2500 : 1500,
    modelTier: "cheap",
  };
}
