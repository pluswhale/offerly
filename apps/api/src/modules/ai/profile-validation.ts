import type { CandidateProfile } from "@offerly/types";
import type { AiService } from "./ai.service.js";
import { collectCandidateProfileEvidenced, type EvidenceVerificationReport } from "./evidence.js";
import { correctAtPath, dropAtPath, getEvidencedAtPath } from "./profile-paths.js";
import { cvValidateV1, type CvValidateItem } from "./prompts/cv-validate.v1.js";
import { normalizeForMatch } from "./text.js";

/** Items below this model-reported confidence go to S3 (spec 003 §FR-1). */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Consistency flags (T2.3): computed in code, adjudicated by the LLM. */
export const LOW_CONFIDENCE_FLAG = "low_confidence";
export const DURATION_INCONSISTENT_FLAG = "duration_inconsistent";
export const MULTIPLE_CURRENT_ROLES_FLAG = "multiple_current_roles";

/** ±300 chars of CV context around an evidence span (spec §FR-10). */
const EXCERPT_RADIUS = 300;

/** Summed vs stated total years outside [0.66x, 1.5x] is flagged (T2.3). */
const DURATION_RATIO_LOW = 0.66;
const DURATION_RATIO_HIGH = 1.5;

export interface RunValidationMeta {
  templateVersion: string;
  /** True when there was nothing to adjudicate — zero LLM usage. */
  skipped: boolean;
  adjudicatedCount: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface RunValidationResult {
  profile: CandidateProfile;
  adjudicatedCount: number;
  meta: RunValidationMeta;
}

/**
 * CV excerpt for one item: ±300 chars around the evidence span in the full CV
 * text. Items without evidence get the excerpt around the first mention of
 * their value; failing that, the headline region (start of the document).
 */
export function excerptAround(cvText: string, evidence: string | null, value: unknown): string {
  const needle = evidence ?? (typeof value === "string" ? value : null);
  // Headline region fallback for items without a locatable mention (T2.3:
  // keep it simple).
  if (!needle) return cvText.slice(0, EXCERPT_RADIUS * 2);
  const index = normalizeForMatch(cvText).indexOf(normalizeForMatch(needle));
  if (index < 0) return cvText.slice(0, EXCERPT_RADIUS * 2);
  // indexOf on the normalized text can drift a few chars vs the raw text when
  // whitespace collapses — the radius dwarfs the drift, so reuse the offset.
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(cvText.length, index + needle.length + EXCERPT_RADIUS);
  return cvText.slice(start, end);
}

/**
 * Parse a free-form role date ("Mar 2019", "2019-03", "present") to a year.
 * Returns null when no 4-digit year is present — the duration check is then
 * skipped rather than guessed (determinism where possible).
 */
function yearOf(dateText: string | null): number | null {
  if (!dateText) return null;
  if (/present|current|now|to date/i.test(dateText)) return new Date().getFullYear();
  const match = /(19|20)\d{2}/.exec(dateText);
  return match ? Number(match[0]) : null;
}

/**
 * Sum role durations in whole years from dated roles. Null when any role
 * lacks parseable dates — the check is skipped, never approximated.
 */
function sumRoleYears(profile: CandidateProfile): number | null {
  let sum = 0;
  for (const role of profile.roles) {
    const start = yearOf(role.start.value);
    const end = yearOf(role.end.value);
    if (start === null || end === null) return null;
    sum += Math.max(0, end - start);
  }
  return sum;
}

/**
 * Cross-field consistency checks in code (T2.3):
 * - summed role durations vs stated headline.total_years_experience
 * - more than one current role
 */
export function collectConsistencyFlags(profile: CandidateProfile): CvValidateItem[] {
  const items: CvValidateItem[] = [];

  const totalYears = profile.headline.total_years_experience;
  if (totalYears.status === "stated" && totalYears.value !== null && totalYears.value > 0) {
    const summed = sumRoleYears(profile);
    if (summed !== null && summed > 0) {
      const ratio = summed / totalYears.value;
      if (ratio > DURATION_RATIO_HIGH || ratio < DURATION_RATIO_LOW) {
        items.push({
          path: "headline.total_years_experience",
          flag: DURATION_INCONSISTENT_FLAG,
          value: totalYears.value,
          evidence: totalYears.evidence,
          excerpt: "", // filled by collectValidationItems
        });
      }
    }
  }

  const currentRoles = profile.roles
    .map((role, index) => ({ role, index }))
    .filter(({ role }) => role.is_current);
  // One current role is normal; flag every current role beyond the first.
  for (const { role, index } of currentRoles.slice(1)) {
    items.push({
      path: `roles[${index}].end`,
      flag: MULTIPLE_CURRENT_ROLES_FLAG,
      value: role.end.value,
      evidence: role.end.evidence,
      excerpt: "",
    });
  }

  return items;
}

/**
 * Assemble the full S3 input set (spec §FR-1): S2-flagged items + stated AI
 * items under the confidence threshold + code-computed consistency flags,
 * each with its CV excerpt. High-confidence verified items are never sent.
 */
export function collectValidationItems(
  profile: CandidateProfile,
  report: EvidenceVerificationReport,
  cvText: string,
): CvValidateItem[] {
  const items: CvValidateItem[] = report.flagged.map((f) => ({
    path: f.path,
    flag: f.flag,
    value: f.value,
    evidence: f.evidence,
    excerpt: "",
  }));
  const seen = new Set(items.map((i) => i.path));

  for (const { path, item } of collectCandidateProfileEvidenced(profile)) {
    if (seen.has(path)) continue;
    if (item.status !== "stated" || item.source === "user") continue;
    if (item.confidence < LOW_CONFIDENCE_THRESHOLD) {
      seen.add(path);
      items.push({
        path,
        flag: LOW_CONFIDENCE_FLAG,
        value: item.value,
        evidence: item.evidence,
        excerpt: "",
      });
    }
  }

  for (const flag of collectConsistencyFlags(profile)) {
    if (seen.has(flag.path)) continue;
    seen.add(flag.path);
    items.push(flag);
  }

  for (const item of items) {
    item.excerpt = excerptAround(cvText, item.evidence, item.value);
  }
  return items;
}

/**
 * S3 (spec 003 §FR-1, T2.3): adjudicate flagged items via cv-validate.v1 and
 * apply keep/correct/drop to a clone of the profile. Skips the LLM call
 * entirely when there is nothing to adjudicate (zero usage). Nothing is
 * re-clamped here — S2 already ran.
 */
export async function runValidation(
  ai: AiService,
  opts: {
    userId: string;
    profile: CandidateProfile;
    flaggedItems: CvValidateItem[];
    cvText: string;
  },
): Promise<RunValidationResult> {
  const started = Date.now();
  if (opts.flaggedItems.length === 0) {
    return {
      profile: opts.profile,
      adjudicatedCount: 0,
      meta: {
        templateVersion: cvValidateV1.templateVersion,
        skipped: true,
        adjudicatedCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - started,
      },
    };
  }

  const result = await ai.generateFromTemplate({
    userId: opts.userId,
    operation: "cv_profile",
    template: cvValidateV1,
    input: { items: opts.flaggedItems },
  });

  const profile = structuredClone(opts.profile);
  const haystack = normalizeForMatch(opts.cvText);
  let adjudicatedCount = 0;

  for (const adj of result.data.adjudications) {
    const leaf = getEvidencedAtPath(profile, adj.path);
    // Unknown paths and user-sourced facts are never adjudicated (spec §FR-4).
    if (!leaf || leaf.source === "user") continue;
    adjudicatedCount += 1;

    if (adj.action === "drop") {
      dropAtPath(profile, adj.path);
      fixCurrentFlag(profile, adj.path);
    } else if (adj.action === "correct" && adj.corrected) {
      // Deterministic guard: the corrected quote must verify verbatim against
      // the CV, same rule as S2 — an unverifiable correction is ignored.
      if (haystack.includes(normalizeForMatch(adj.corrected.evidence))) {
        correctAtPath(profile, adj.path, adj.corrected.value, adj.corrected.evidence);
        fixCurrentFlag(profile, adj.path);
      }
    }
    // 'keep' — nothing to apply.
  }

  return {
    profile,
    adjudicatedCount,
    meta: {
      templateVersion: cvValidateV1.templateVersion,
      skipped: false,
      adjudicatedCount,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: Date.now() - started,
    },
  };
}

/** is_current is derived from roles[i].end — keep it in sync after edits. */
function fixCurrentFlag(profile: CandidateProfile, path: string): void {
  const match = /^roles\[(\d+)\]\.end$/.exec(path);
  if (!match) return;
  const role = profile.roles[Number(match[1])];
  if (!role) return;
  role.is_current =
    role.end.status === "stated" && /present|current|now|to date/i.test(role.end.value ?? "");
}
