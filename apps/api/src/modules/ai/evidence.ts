import type {
  CandidateProfile,
  Evidenced,
  JobProfile,
  ProfileSkills,
} from "@offerly/types";
import { normalizeForMatch } from "./text.js";

/**
 * S2 — deterministic evidence verification (spec 003 §FR-1). Code, not an LLM
 * call: every `status: 'stated'` item's evidence quote must substring-match the
 * source document after normalizeForMatch. Failures are flagged
 * `evidence_unverified`, their confidence is clamped to ≤0.4, and they are
 * collected in the report for the conditional S3 adjudicator.
 */

export const EVIDENCE_UNVERIFIED_FLAG = "evidence_unverified" as const;

/** Confidence ceiling applied by S2 to items whose evidence does not verify. */
export const UNVERIFIED_CONFIDENCE_CAP = 0.4;

/** One Evidenced leaf found while walking a profile-shaped document. */
export interface EvidencedEntry {
  /** Dot/bracket path, e.g. "skills.databases[0]" — cited by S3 and match reports. */
  path: string;
  item: Evidenced<unknown>;
}

export interface FlaggedEvidenceItem {
  path: string;
  flag: typeof EVIDENCE_UNVERIFIED_FLAG;
  value: unknown;
  /** The quote that failed the verbatim check. */
  evidence: string;
}

export interface EvidenceVerificationReport {
  /** Stated, AI-sourced items checked (user-sourced and unknown items skipped). */
  totalCount: number;
  verifiedCount: number;
  flagged: FlaggedEvidenceItem[];
}

/**
 * Verify every stated, AI-sourced Evidenced leaf against the source text.
 * MUTATES the passed items: unverifiable evidence clamps confidence to ≤0.4
 * (spec §FR-1). User-sourced facts (source: 'user', evidence null) are user
 * statements, not AI claims — skipped by verification (spec §FR-4).
 */
export function verifyEvidencedEntries(
  entries: EvidencedEntry[],
  sourceText: string,
): EvidenceVerificationReport {
  const haystack = normalizeForMatch(sourceText);
  const report: EvidenceVerificationReport = { totalCount: 0, verifiedCount: 0, flagged: [] };

  for (const { path, item } of entries) {
    if (item.status !== "stated" || item.source === "user") continue;
    report.totalCount += 1;
    // Stated-without-evidence is a schema violation; verify it as a failure
    // rather than letting it slip through silently.
    const needle = item.evidence === null ? "" : normalizeForMatch(item.evidence);
    if (needle.length > 0 && haystack.includes(needle)) {
      report.verifiedCount += 1;
    } else {
      item.confidence = Math.min(item.confidence, UNVERIFIED_CONFIDENCE_CAP);
      report.flagged.push({
        path,
        flag: EVIDENCE_UNVERIFIED_FLAG,
        value: item.value,
        evidence: item.evidence ?? "",
      });
    }
  }
  return report;
}

/** Walk every Evidenced leaf of a CandidateProfile (spec §FR-2). */
export function collectCandidateProfileEvidenced(profile: CandidateProfile): EvidencedEntry[] {
  const entries: EvidencedEntry[] = [];
  const add = (path: string, item: Evidenced<unknown>) => entries.push({ path, item });

  add("headline.title", profile.headline.title);
  add("headline.seniority", profile.headline.seniority);
  add("headline.total_years_experience", profile.headline.total_years_experience);

  profile.roles.forEach((role, i) => {
    add(`roles[${i}].title`, role.title);
    add(`roles[${i}].company`, role.company);
    add(`roles[${i}].start`, role.start);
    add(`roles[${i}].end`, role.end);
    add(`roles[${i}].industry`, role.industry);
    add(`roles[${i}].scope`, role.scope);
  });

  for (const group of Object.keys(profile.skills) as Array<keyof ProfileSkills>) {
    profile.skills[group].forEach((skill, i) => add(`skills.${group}[${i}]`, skill));
  }

  profile.experience.industries.forEach((item, i) => add(`experience.industries[${i}]`, item));
  profile.experience.domains.forEach((item, i) => add(`experience.domains[${i}]`, item));
  add("experience.team_sizes_managed", profile.experience.team_sizes_managed);
  add("experience.leadership", profile.experience.leadership);
  add("experience.leadership_scope", profile.experience.leadership_scope);
  add("experience.management", profile.experience.management);
  add("experience.management_scope", profile.experience.management_scope);

  profile.education.forEach((edu, i) => {
    add(`education[${i}].degree`, edu.degree);
    add(`education[${i}].institution`, edu.institution);
    add(`education[${i}].year`, edu.year);
  });

  profile.certifications.forEach((cert, i) => {
    add(`certifications[${i}].name`, cert.name);
    add(`certifications[${i}].issuer`, cert.issuer);
    add(`certifications[${i}].year`, cert.year);
  });

  profile.languages.forEach((lang, i) => {
    add(`languages[${i}].language`, lang.language);
    add(`languages[${i}].level`, lang.level);
  });

  add("location.current", profile.location.current);
  profile.location.work_authorization.forEach((item, i) =>
    add(`location.work_authorization[${i}]`, item),
  );
  add("location.remote_preference", profile.location.remote_preference);

  return entries;
}

/** S2 entry point for Candidate Profiles (spec §FR-1). */
export function verifyCandidateProfileEvidence(
  profile: CandidateProfile,
  cvText: string,
): EvidenceVerificationReport {
  return verifyEvidencedEntries(collectCandidateProfileEvidenced(profile), cvText);
}

/** Walk every Evidenced leaf of a JobProfile (spec §FR-5). */
export function collectJobProfileEvidenced(profile: JobProfile): EvidencedEntry[] {
  const entries: EvidencedEntry[] = [];
  const add = (path: string, item: Evidenced<unknown>) => entries.push({ path, item });

  profile.required_skills.forEach((skill, i) => add(`required_skills[${i}]`, skill));
  profile.preferred_skills.forEach((skill, i) => add(`preferred_skills[${i}]`, skill));
  add("min_years_experience", profile.min_years_experience);
  add("industry", profile.industry);
  add("location", profile.location);
  add("remote_policy", profile.remote_policy);
  profile.languages.forEach((lang, i) => add(`languages[${i}]`, lang));
  profile.education_requirements.forEach((req, i) => add(`education_requirements[${i}]`, req));
  profile.requirements.forEach((req, i) => add(`requirements[${i}].text`, req.text));

  return entries;
}

/** S2 entry point for Job Profiles (spec §FR-5): same verbatim check as S2 for CVs. */
export function verifyJobProfileEvidence(
  profile: JobProfile,
  jdText: string,
): EvidenceVerificationReport {
  return verifyEvidencedEntries(collectJobProfileEvidenced(profile), jdText);
}
