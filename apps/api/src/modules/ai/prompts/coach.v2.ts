import type { CandidateProfile, Evidenced, EvidencedSkill, UserGoals } from "@offerly/types";
import { collectCandidateProfileEvidenced } from "../evidence.js";
import { estimateTokens, normalizeForMatch, truncateText } from "../text.js";
import { dataBlock, UNTRUSTED_DATA_RULE } from "./prompt.types.js";

export const templateVersion = "coach.v2";

/** Spec 003 §FR-11: the coach's system context stays under this estimate. */
export const COACH_CONTEXT_TOKEN_BUDGET = 2_500;

/** Max matches surfaced in the manifest (spec §FR-11: top-5 match reports). */
export const COACH_MANIFEST_MAX_MATCHES = 5;

/** One skill group in the compact projection — values only, never evidence. */
export interface CoachSkillGroup {
  path: string; // e.g. "skills.programming_languages"
  values: string[];
}

/**
 * Compact, coach-oriented Candidate Profile projection (spec 003 §FR-11,
 * T4.3): field paths + values + statuses, evidence quotes dropped (fetched on
 * demand only). Unlike buildProfileProjection (match-requirements), this is
 * prose-shaped for a chat persona and includes roles, summary_quality and
 * target-relevant context. Arrays carry stated members only — absence reads
 * as silence, same as the matching projection.
 */
export interface CoachProfileProjection {
  /** Profile completeness 0–100 (derived in S4); null when absent. */
  summaryQuality: number | null;
  /** "path: value (status)" lines for title/seniority/total years. */
  headline: string[];
  /** Stated, non-empty skill groups only. */
  skills: CoachSkillGroup[];
  /** "roles[i]: Title @ Company, start–end" — stated parts only. */
  roles: string[];
  /** industries/domains/leadership/management lines. */
  experience: string[];
  education: string[];
  certifications: string[];
  languages: string[];
  location: string[];
}

/** Top-5 match summary: score + must-have gaps (spec §FR-11). */
export interface CoachMatchSummary {
  jobTitle: string | null;
  company: string | null;
  score: number;
  lowConfidence: boolean;
  /** Must-have requirement texts (or ids) with verdict missing/partial. */
  gaps: string[];
}

/** On-demand evidence quote, included only when the user challenges a claim. */
export interface CoachEvidenceQuote {
  path: string;
  value: string;
  quote: string;
}

/** Everything the coach is allowed to know (spec §FR-11 context manifest). */
export interface CoachManifest {
  fullName: string | null;
  currentRole: string | null;
  targetRole: string | null;
  goals: UserGoals | null;
  /** null ⇔ no ready profile — the prompt suggests building one. */
  profile: CoachProfileProjection | null;
  /** Top matches by score, most recent first among equals. */
  matches: CoachMatchSummary[];
  /** Application status → count. */
  pipeline: Record<string, number>;
  /** Applications with no status change in 14+ days. */
  staleApplications: number;
  /** Last assistant reply — continuity without repeating it verbatim. */
  lastAdvice: string | null;
  /** Evidence drill-down quotes (only on "why do you think…" challenges). */
  evidence: CoachEvidenceQuote[];
}

function scalarLine<T>(path: string, leaf: Evidenced<T>): string {
  const value = leaf.status === "stated" && leaf.value !== null ? String(leaf.value) : "unknown";
  return `${path}: ${value} (${leaf.status})`;
}

function statedValue<T>(leaf: Evidenced<T>): string | null {
  return leaf.status === "stated" && leaf.value !== null ? String(leaf.value) : null;
}

export function buildCoachProfileProjection(profile: CandidateProfile): CoachProfileProjection {
  const skills: CoachSkillGroup[] = [];
  const skillGroups = Object.keys(profile.skills) as Array<keyof CandidateProfile["skills"]>;
  for (const group of skillGroups) {
    const groupSkills: EvidencedSkill[] = profile.skills[group];
    const values = groupSkills
      .map((skill) => {
        const value = statedValue(skill);
        if (value === null) return null;
        const years = typeof skill.years === "number" ? ` (${skill.years}y)` : "";
        return `${value}${years}`;
      })
      .filter((value): value is string => value !== null);
    if (values.length > 0) skills.push({ path: `skills.${group}`, values });
  }

  const roles = profile.roles.map((role, index) => {
    const title = statedValue(role.title) ?? "unknown title";
    const company = statedValue(role.company);
    const start = statedValue(role.start);
    const end = statedValue(role.end);
    const period = start !== null || end !== null ? `, ${start ?? "?"}–${end ?? "?"}` : "";
    const current = role.is_current ? " (current)" : "";
    return `roles[${index}]: ${title}${company !== null ? ` @ ${company}` : ""}${period}${current}`;
  });

  const experience: string[] = [];
  const industries = profile.experience.industries.map(statedValue).filter((v) => v !== null);
  if (industries.length > 0) experience.push(`experience.industries: ${industries.join(", ")}`);
  const domains = profile.experience.domains.map(statedValue).filter((v) => v !== null);
  if (domains.length > 0) experience.push(`experience.domains: ${domains.join(", ")}`);
  const leadership = statedValue(profile.experience.leadership);
  if (leadership === "true") {
    const scope = statedValue(profile.experience.leadership_scope);
    experience.push(`experience.leadership: yes${scope !== null ? ` (${scope})` : ""}`);
  }
  const management = statedValue(profile.experience.management);
  if (management === "true") {
    const scope = statedValue(profile.experience.management_scope);
    experience.push(`experience.management: yes${scope !== null ? ` (${scope})` : ""}`);
  }
  const teamSizes = statedValue(profile.experience.team_sizes_managed);
  if (teamSizes !== null) experience.push(`experience.team_sizes_managed: ${teamSizes}`);

  const education = profile.education.map((entry, index) => {
    const parts = [statedValue(entry.degree), statedValue(entry.institution)].filter(
      (v): v is string => v !== null,
    );
    const year = statedValue(entry.year);
    return `education[${index}]: ${parts.join(", ") || "unknown"}${year !== null ? ` (${year})` : ""}`;
  });

  const certifications = profile.certifications.map((entry, index) => {
    const name = statedValue(entry.name) ?? "unknown";
    const issuer = statedValue(entry.issuer);
    const year = statedValue(entry.year);
    return `certifications[${index}]: ${name}${issuer !== null ? ` (${issuer})` : ""}${
      year !== null ? ` ${year}` : ""
    }`;
  });

  const languages = profile.languages
    .map((entry) => {
      const language = statedValue(entry.language);
      if (language === null) return null;
      const level = statedValue(entry.level);
      return level !== null ? `${language} (${level})` : language;
    })
    .filter((v): v is string => v !== null);

  const location: string[] = [];
  const current = statedValue(profile.location.current);
  if (current !== null) location.push(`location.current: ${current}`);
  const workAuth = profile.location.work_authorization
    .map(statedValue)
    .filter((v): v is string => v !== null);
  if (workAuth.length > 0) location.push(`location.work_authorization: ${workAuth.join(", ")}`);
  const remote = statedValue(profile.location.remote_preference);
  if (remote !== null) location.push(`location.remote_preference: ${remote}`);

  return {
    summaryQuality: profile.summary_quality ?? null,
    headline: [
      scalarLine("headline.title", profile.headline.title),
      scalarLine("headline.seniority", profile.headline.seniority),
      scalarLine("headline.total_years_experience", profile.headline.total_years_experience),
    ],
    skills,
    roles,
    experience,
    education,
    certifications,
    languages: languages.length > 0 ? [`languages: ${languages.join(", ")}`] : [],
    location,
  };
}

/**
 * Evidence drill-down heuristic (spec §FR-11, T4.3): fires when the user
 * challenges a claim ("why do you think/say…", "what evidence…"). Deliberately
 * simple — a false positive just adds a few quotes to one message.
 */
export function isEvidenceChallenge(message: string): boolean {
  return (
    /\bwhy\b/i.test(message) &&
    /\b(think|say|said|claim|claims|evidence|believe|based|know)\b/i.test(message)
  );
}

const MAX_EVIDENCE_QUOTES = 5;
const EVIDENCE_QUOTE_CHARS = 200;

/**
 * Resolve evidence quotes for profile facts the user's message mentions
 * (value substring match, normalized like S2). The coach otherwise answers
 * from values and points to the profile UI — quotes are the on-demand
 * exception, never part of the default manifest.
 */
export function collectChallengeEvidence(
  profile: CandidateProfile,
  message: string,
): CoachEvidenceQuote[] {
  const haystack = normalizeForMatch(message);
  const quotes: CoachEvidenceQuote[] = [];
  for (const { path, item } of collectCandidateProfileEvidenced(profile)) {
    if (quotes.length >= MAX_EVIDENCE_QUOTES) break;
    if (item.status !== "stated" || item.evidence === null) continue;
    if (typeof item.value !== "string" || item.value.length < 3) continue;
    if (!haystack.includes(normalizeForMatch(item.value))) continue;
    quotes.push({
      path,
      value: item.value,
      quote: truncateText(item.evidence, EVIDENCE_QUOTE_CHARS).text,
    });
  }
  return quotes;
}

/** Trim level caps — identity and goals are never trimmed (T4.3 budgeter). */
interface TrimCaps {
  matches: number;
  gapsPerMatch: number;
  skillsPerGroup: number;
  maxRoles: number;
  includeCertifications: boolean;
}

const TRIM_LEVELS: TrimCaps[] = [
  { matches: COACH_MANIFEST_MAX_MATCHES, gapsPerMatch: 3, skillsPerGroup: 10, maxRoles: 6, includeCertifications: true },
  { matches: COACH_MANIFEST_MAX_MATCHES, gapsPerMatch: 2, skillsPerGroup: 7, maxRoles: 4, includeCertifications: true },
  { matches: 3, gapsPerMatch: 1, skillsPerGroup: 5, maxRoles: 3, includeCertifications: false },
  { matches: 1, gapsPerMatch: 0, skillsPerGroup: 3, maxRoles: 2, includeCertifications: false },
];

function renderGoals(goals: UserGoals): string {
  const parts: string[] = [];
  if (goals.target_location) parts.push(`target location: ${goals.target_location}`);
  if (goals.target_salary) {
    const s = goals.target_salary;
    parts.push(`target salary: ${s.amount} ${s.currency}/${s.period}`);
  }
  if (goals.priority) parts.push(`priority: ${goals.priority}`);
  return parts.join("; ");
}

function renderManifest(manifest: CoachManifest, caps: TrimCaps): string {
  const lines: string[] = [];
  lines.push(`Name: ${manifest.fullName ?? "unknown"}`);
  lines.push(`Current role: ${manifest.currentRole ?? "unknown"}`);
  lines.push(`Target role: ${manifest.targetRole ?? "unknown"}`);
  if (manifest.goals) {
    const goals = renderGoals(manifest.goals);
    if (goals.length > 0) lines.push(`Goals: ${goals}`);
  }

  if (manifest.profile) {
    const p = manifest.profile;
    lines.push("");
    lines.push(
      `Candidate profile (verified facts from the user's CV — values and statuses only${
        p.summaryQuality !== null ? `; profile completeness ${p.summaryQuality}%` : ""
      }):`,
    );
    lines.push(...p.headline);
    for (const group of p.skills) {
      lines.push(`${group.path}: ${group.values.slice(0, caps.skillsPerGroup).join(", ")}`);
    }
    lines.push(...p.roles.slice(0, caps.maxRoles));
    lines.push(...p.experience);
    lines.push(...p.education);
    if (caps.includeCertifications) lines.push(...p.certifications);
    lines.push(...p.languages);
    lines.push(...p.location);
  } else {
    lines.push("");
    lines.push(
      "(No candidate profile yet — the user's CV has not been analyzed. Suggest uploading a CV and building the profile before giving CV-specific advice.)",
    );
  }

  if (manifest.matches.length > 0) {
    lines.push("");
    lines.push("Top job matches (by score):");
    for (const match of manifest.matches.slice(0, caps.matches)) {
      const label = [match.jobTitle, match.company].filter((v) => v !== null).join(" @ ") || "a job";
      const confidence = match.lowConfidence ? ", low confidence" : "";
      const gaps = match.gaps.slice(0, caps.gapsPerMatch);
      lines.push(
        `- ${label}: score ${match.score}${confidence}${gaps.length > 0 ? `; gaps: ${gaps.join(", ")}` : ""}`,
      );
    }
  }

  const pipeline =
    Object.entries(manifest.pipeline)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ") || "empty";
  lines.push("");
  lines.push(
    `Application pipeline: ${pipeline}${manifest.staleApplications > 0 ? ` (${manifest.staleApplications} with no progress in 14+ days)` : ""}`,
  );

  if (manifest.lastAdvice) {
    lines.push("");
    lines.push(`Your most recent advice (build on it, do not repeat it): ${manifest.lastAdvice}`);
  }

  if (manifest.evidence.length > 0) {
    lines.push("");
    lines.push("Evidence quotes from the user's CV for the facts they asked about:");
    for (const quote of manifest.evidence) {
      lines.push(`- ${quote.path} = "${quote.value}" — quote: "${quote.quote}"`);
    }
  }

  return lines.join("\n");
}

/**
 * Coach system prompt (spec 003 §FR-11, T4.3). Persona + honesty rules carried
 * over from coach.v1; the raw CV block is replaced by the budgeted context
 * manifest — the coach literally cannot see unprofiled CV claims. Budget
 * (≤2.5k tokens est.): match summaries trim first (gaps, then matches), then
 * profile arrays; identity and goals are never trimmed.
 */
export function buildCoachSystemPrompt(manifest: CoachManifest): string {
  const persona =
    "You are a career coach inside a job-search app. Give concise, practical, encouraging advice " +
    "grounded in the user's actual situation below. Stay on topic: job search, CVs, interviews, " +
    "career moves. For anything off-topic, politely redirect to job-search help. " +
    "Never claim the user has experience they have not stated. " +
    "Answer only from the facts in the context manifest below — it is the complete, verified " +
    "record of what the user's CV states; you do not have the raw CV text. If the user asks about " +
    "their CV, answer from the profile facts and point them to the profile and improvements " +
    "screens in the app. When advice calls for it, suggest concrete in-product actions: upload a " +
    "CV, build the candidate profile, match a job, or track an application. " +
    UNTRUSTED_DATA_RULE;

  for (let level = 0; level < TRIM_LEVELS.length; level++) {
    const caps = TRIM_LEVELS[level]!;
    const prompt = `${persona}\n\nUser context:\n${dataBlock("coach_context", renderManifest(manifest, caps))}`;
    if (estimateTokens(prompt) <= COACH_CONTEXT_TOKEN_BUDGET) return prompt;
  }
  // Final guard: drop the last-advice echo (continuity nicety, never facts).
  const caps = TRIM_LEVELS[TRIM_LEVELS.length - 1]!;
  return `${persona}\n\nUser context:\n${dataBlock("coach_context", renderManifest({ ...manifest, lastAdvice: null }, caps))}`;
}
