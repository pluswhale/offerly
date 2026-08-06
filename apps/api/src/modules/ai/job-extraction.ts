import type { JobProfile } from "@offerly/types";
import type { AiService } from "./ai.service.js";
import {
  verifyJobProfileEvidence,
  type EvidenceVerificationReport,
} from "./evidence.js";
import { jdExtractV1 } from "./prompts/jd-extract.v1.js";
import { truncateText } from "./text.js";

/** Extraction input cap (spec 003 §FR-10): same ~20k chars as CV extraction. */
export const JD_EXTRACT_MAX_CHARS = 20_000;

export interface ExtractJobProfileMeta {
  templateVersion: string;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
  /** True when the JD exceeded JD_EXTRACT_MAX_CHARS and was truncated. */
  truncated: boolean;
  /** Characters of JD text actually sent to the model. */
  analyzedChars: number;
}

export interface ExtractJobProfileResult {
  profile: JobProfile;
  /** Verification outcome; flagged items are already confidence-clamped. */
  report: EvidenceVerificationReport;
  meta: ExtractJobProfileMeta;
}

/**
 * JD structuring (spec 003 §FR-5): truncate → jd-extract.v1 via the gateway
 * (operation `jd_extract`; only a cache miss consumes quota) → the same
 * deterministic evidence verification S2 applies to CVs, against the text the
 * model actually saw. Persistence is the caller's job (JobProfileService).
 */
export async function extractJobProfile(
  ai: AiService,
  opts: { userId: string; jdText: string; contentHash: string; skipCache?: boolean },
): Promise<ExtractJobProfileResult> {
  const truncated = truncateText(opts.jdText, JD_EXTRACT_MAX_CHARS);
  const result = await ai.generateFromTemplate({
    userId: opts.userId,
    operation: "jd_extract",
    template: jdExtractV1,
    input: {
      jdText: truncated.text,
      contentHash: opts.contentHash,
      truncated: truncated.truncated,
    },
    skipCache: opts.skipCache,
  });
  const report = verifyJobProfileEvidence(result.data, truncated.text);
  return {
    profile: result.data,
    report,
    meta: {
      templateVersion: jdExtractV1.templateVersion,
      cacheHit: result.cacheHit,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      truncated: truncated.truncated,
      analyzedChars: truncated.text.length,
    },
  };
}
