import type { CandidateProfile, Evidenced } from "@offerly/types";

/**
 * summary_quality (spec 003 §FR-2, derived in S4 — never extracted):
 * profile completeness 0–100, shown to the user as "Profile completeness".
 *
 * Weighting (total 100) — skills and experience carry the most weight because
 * matching consumes them most:
 *   headline       20  (title 10, seniority 5, total years 5)
 *   roles          15  (share of roles with stated title/company)
 *   skills         25  (share of the 7 groups that are non-empty)
 *   experience     15  (industries 5, domains 5, leadership|management 5)
 *   education       8  (any entry)
 *   languages       8  (any entry)
 *   location        5  (current location stated)
 *   certifications  4  (any entry)
 * Array groups count as covered when non-empty; scalar leaves when 'stated'.
 */

const stated = (leaf: Evidenced<unknown>): boolean => leaf.status === "stated";

export function computeSummaryQuality(profile: CandidateProfile): number {
  let score = 0;

  if (stated(profile.headline.title)) score += 10;
  if (stated(profile.headline.seniority)) score += 5;
  if (stated(profile.headline.total_years_experience)) score += 5;

  if (profile.roles.length > 0) {
    const covered = profile.roles.filter(
      (role) => stated(role.title) && stated(role.company),
    ).length;
    score += 15 * (covered / profile.roles.length);
  }

  const skillGroups = Object.values(profile.skills);
  const nonEmptyGroups = skillGroups.filter((group) => group.length > 0).length;
  score += 25 * (nonEmptyGroups / skillGroups.length);

  if (profile.experience.industries.length > 0) score += 5;
  if (profile.experience.domains.length > 0) score += 5;
  if (stated(profile.experience.leadership) || stated(profile.experience.management)) score += 5;

  if (profile.education.length > 0) score += 8;
  if (profile.languages.length > 0) score += 8;
  if (stated(profile.location.current)) score += 5;
  if (profile.certifications.length > 0) score += 4;

  return Math.round(score);
}
