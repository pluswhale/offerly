import type {
  CandidateProfile,
  JobProfile,
  RemotePreference,
  RequirementCategory,
} from "@offerly/types";
import { normalizeForMatch } from "../text.js";
import {
  WEIGHTS_V1,
  type ScoreWeights,
  type ScoredVerdict,
  type StaticComponent,
} from "./weights.js";

/**
 * Static (non-requirement-list) score components (spec 003 §FR-8, T3.4):
 * experience ramp, industry, location/remote, languages and education, each
 * normalized to 0–1 for computeScore. Pure functions, no I/O — identical
 * inputs give identical outputs, so a repeated match is bit-identical (AC-4).
 *
 * Silence is never evidence against the candidate (§FR-7 semantics): a profile
 * or JD field with status 'unknown' scores NEUTRAL, not 0. A JD that states no
 * constraint (no min years, no remote policy, no requirement in a category)
 * scores 1.0 — nothing mandatory is unmet, same convention as computeScore.
 */

/** Scored verdict tagged with its requirement's category (for category components). */
export interface CategorizedVerdict extends ScoredVerdict {
  category: RequirementCategory;
}

/** Neutral score when the profile (or the JD) is silent on a component. */
const NEUTRAL = 0.5;

/** Full string plus its comma-separated parts ("Berlin, Germany" → "berlin"). */
function placeParts(value: string): string[] {
  return [value, ...value.split(",")]
    .map((part) => normalizeForMatch(part))
    .filter((part) => part.length > 0);
}

function placesOverlap(a: string, b: string): boolean {
  const aParts = placeParts(a);
  const bParts = placeParts(b);
  return aParts.some((x) => bParts.some((y) => x === y || x.includes(y) || y.includes(x)));
}

/**
 * Experience ramp vs the JD's min_years_experience (§FR-8): the ratio of
 * stated candidate years to the requirement, capped at 1. No stated minimum →
 * 1.0; candidate years unknown → NEUTRAL.
 */
function experienceScore(profile: CandidateProfile, jobProfile: JobProfile): number {
  const min = jobProfile.min_years_experience;
  if (min.status !== "stated" || min.value === null || min.value <= 0) return 1.0;
  const years = profile.headline.total_years_experience;
  if (years.status !== "stated" || years.value === null) return NEUTRAL;
  return Math.min(1, years.value / min.value);
}

/**
 * Location/remote deterministic rule (§FR-8). Remote/hybrid policies score the
 * candidate's stated preference (hybrid-vs-remote stays fuzzy at NEUTRAL, like
 * the pre-pass); onsite compares stated places. An unstated policy imposes no
 * constraint → 1.0.
 */
function locationRemoteScore(profile: CandidateProfile, jobProfile: JobProfile): number {
  const policyLeaf = jobProfile.remote_policy;
  const policy = policyLeaf.status === "stated" ? policyLeaf.value : null;
  const prefLeaf = profile.location.remote_preference;
  const pref: RemotePreference | null = prefLeaf.status === "stated" ? prefLeaf.value : null;

  if (policy === "remote") {
    if (pref === null) return NEUTRAL;
    if (pref === "remote" || pref === "any") return 1.0;
    if (pref === "hybrid") return NEUTRAL;
    return 0; // positively onsite-only vs a remote job
  }
  if (policy === "hybrid") {
    if (pref === null) return NEUTRAL;
    if (pref === "hybrid" || pref === "any") return 1.0;
    if (pref === "remote") return NEUTRAL;
    return 0;
  }
  if (policy === "onsite") {
    const jobLoc = jobProfile.location.status === "stated" ? jobProfile.location.value : null;
    const candLoc = profile.location.current.status === "stated" ? profile.location.current.value : null;
    if (jobLoc === null || candLoc === null) return NEUTRAL;
    return placesOverlap(jobLoc, candLoc) ? 1.0 : 0;
  }
  return 1.0; // policy unknown → the JD states no location/remote constraint
}

/**
 * Verdict-based component (industry / languages / education, §FR-8 "verdict"
 * basis): the per-verdict scores of that category's requirements, averaged
 * with the same importance-aware maps computeScore uses. A category with no
 * requirements scores 1.0.
 */
function categoryComponent(
  verdicts: readonly CategorizedVerdict[],
  category: RequirementCategory,
  weights: ScoreWeights,
): number {
  const inCategory = verdicts.filter((v) => v.category === category);
  if (inCategory.length === 0) return 1.0;
  let sum = 0;
  for (const v of inCategory) {
    const map =
      v.importance === "must_have" ? weights.mustHaveVerdictScores : weights.niceToHaveVerdictScores;
    sum += map[v.verdict];
  }
  return sum / inCategory.length;
}

/** All static components, each 0–1 (input to computeScore). */
export function buildStaticComponents(
  profile: CandidateProfile,
  jobProfile: JobProfile,
  verdicts: readonly CategorizedVerdict[],
  weights: ScoreWeights = WEIGHTS_V1,
): Record<StaticComponent, number> {
  return {
    experience: experienceScore(profile, jobProfile),
    industry: categoryComponent(verdicts, "industry", weights),
    location_remote: locationRemoteScore(profile, jobProfile),
    languages: categoryComponent(verdicts, "language", weights),
    education: categoryComponent(verdicts, "education", weights),
  };
}
