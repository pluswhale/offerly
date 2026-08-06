import type { CandidateProfile } from "@offerly/types";
import type { AiService } from "./ai.service.js";
import {
  verifyCandidateProfileEvidence,
  type EvidenceVerificationReport,
} from "./evidence.js";
import { cvExtractV1 } from "./prompts/cv-extract.v1.js";
import { truncateText } from "./text.js";

/** Extraction input cap (spec 003 §FR-10): ~20k chars, cut at a line boundary. */
export const CV_EXTRACT_MAX_CHARS = 20_000;

export interface ExtractCandidateProfileMeta {
  templateVersion: string;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
  /** True when the CV exceeded CV_EXTRACT_MAX_CHARS and was truncated. */
  truncated: boolean;
  /** Characters of CV text actually sent to the model. */
  analyzedChars: number;
}

export interface ExtractCandidateProfileResult {
  profile: CandidateProfile;
  /** S2 verification outcome; flagged items are already confidence-clamped. */
  report: EvidenceVerificationReport;
  meta: ExtractCandidateProfileMeta;
}

/**
 * S1+S2 for one CV (spec 003 §FR-1): truncate → cv-extract.v1 via the gateway
 * (operation `cv_profile`; only a cache miss consumes quota) → deterministic
 * evidence verification against the text the model actually saw. S3
 * adjudication of `report.flagged` and persistence are the orchestrator's job
 * (T2.3/T2.4), not this function's.
 */
export async function extractCandidateProfile(
  ai: AiService,
  opts: { userId: string; cvText: string; contentHash: string; skipCache?: boolean },
): Promise<ExtractCandidateProfileResult> {
  const truncated = truncateText(opts.cvText, CV_EXTRACT_MAX_CHARS);
  const result = await ai.generateFromTemplate({
    userId: opts.userId,
    operation: "cv_profile",
    template: cvExtractV1,
    input: {
      cvText: truncated.text,
      contentHash: opts.contentHash,
      truncated: truncated.truncated,
    },
    skipCache: opts.skipCache,
  });
  const report = verifyCandidateProfileEvidence(result.data, truncated.text);
  return {
    profile: result.data,
    report,
    meta: {
      templateVersion: cvExtractV1.templateVersion,
      cacheHit: result.cacheHit,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      truncated: truncated.truncated,
      analyzedChars: truncated.text.length,
    },
  };
}
