import type {
  CandidateProfile,
  Evidenced,
  JobRequirement,
  LanguageLevel,
  ProfileLanguage,
  ProfileSkills,
  RequirementVerdict,
  VerdictValue,
} from "@offerly/types";
import { normalizeForMatch } from "../text.js";
import { canonicalizePhrase, canonicalizeSkill } from "./aliases.js";

/**
 * Deterministic requirement resolution (spec 003 §FR-7 step 1, T3.2).
 *
 * resolveRequirement returns a RequirementVerdict when a requirement is fully
 * decidable from the Candidate Profile by rule alone, or null when it must go
 * to the LLM pass (match-requirements.v1, T3.3). Pure functions, no I/O.
 *
 * The UNKNOWN-vs-MISSING distinction is load-bearing (spec §FR-7):
 *  - 'unknown' is produced ONLY when the relevant profile field's status is
 *    'unknown' — the profile is silent; we do not claim the candidate lacks it.
 *  - 'missing' requires positive evidence that the space is covered and the
 *    requirement isn't met (e.g. languages EN/RU stated, German required).
 *    'missing' is NEVER emitted from silence.
 * Anything fuzzy (adjacent skills, hybrid-vs-remote, unparseable degrees)
 * returns null and is left to the LLM.
 */

/** Deterministic verdicts are rule-certain given the profile. */
const RULE_CONFIDENCE = 1;

function verdict(
  req: JobRequirement,
  value: VerdictValue,
  candidateEvidence: string[],
  reasoning: string,
): RequirementVerdict {
  return {
    requirement_id: req.id,
    verdict: value,
    confidence: RULE_CONFIDENCE,
    candidate_evidence: candidateEvidence,
    reasoning,
  };
}

/** "skills.databases[0]: \"PostgreSQL 9\"" — path plus its evidence quote. */
function evidenceRef(path: string, leaf: Evidenced<unknown>): string {
  return leaf.evidence !== null && leaf.evidence.length > 0
    ? `${path}: "${leaf.evidence}"`
    : path;
}

/**
 * Chars that extend a token — tech names are full of them ("c++", "c#",
 * "node.js", "ci/cd", "objective-c"), so plain \b word boundaries misfire.
 */
const WORD_CHAR = /[\p{L}\p{N}+#./-]/u;

/** Phrase containment on normalized text with tech-aware token boundaries. */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? "" : haystack.charAt(idx - 1);
    const afterIdx = idx + needle.length;
    const after = afterIdx >= haystack.length ? "" : haystack.charAt(afterIdx);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = idx + 1;
  }
}

/* ---------------- skills ---------------- */

const SKILL_GROUPS = [
  "programming_languages",
  "frameworks",
  "cloud_platforms",
  "databases",
  "devops_tools",
  "other_technologies",
  "soft_skills",
] as const satisfies readonly (keyof ProfileSkills)[];

/**
 * Exact/alias overlap only: a stated profile skill whose canonical form
 * appears in the canonicalized requirement text → 'match'. Absence of overlap
 * is NOT 'missing' (skill arrays don't positively cover the whole skill
 * space) and fuzzy adjacency ("react" vs "react native") is not resolved
 * here — both return null for the LLM pass.
 */
function resolveSkill(req: JobRequirement, profile: CandidateProfile): RequirementVerdict | null {
  const reqText = req.text.value;
  if (reqText === null) return null;
  const reqCanonical = canonicalizePhrase(reqText);
  for (const group of SKILL_GROUPS) {
    const skills = profile.skills[group];
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      if (skill === undefined) continue;
      if (skill.status !== "stated" || skill.value === null) continue;
      const skillCanonical = canonicalizeSkill(skill.value);
      if (containsPhrase(reqCanonical, skillCanonical)) {
        return verdict(
          req,
          "match",
          [evidenceRef(`skills.${group}[${i}]`, skill)],
          `Profile lists "${skill.value}" (skills.${group}[${i}]), which matches the requirement.`,
        );
      }
    }
  }
  return null;
}

/* ---------------- experience (years) ---------------- */

const YEARS_RANGE = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*\+?\s*years?/;
const YEARS_PLUS = /(\d{1,2})\s*\+\s*years?/;
const YEARS_PLAIN = /(\d{1,2})\s*years?/;

/** Minimum years required by text like "5+ years", "3-5 years", "5 years". */
export function parseMinYears(text: string): number | null {
  const normalized = normalizeForMatch(text);
  const range = YEARS_RANGE.exec(normalized);
  if (range?.[1] !== undefined) return Number(range[1]);
  const plus = YEARS_PLUS.exec(normalized);
  if (plus?.[1] !== undefined) return Number(plus[1]);
  const plain = YEARS_PLAIN.exec(normalized);
  if (plain?.[1] !== undefined) return Number(plain[1]);
  return null;
}

function resolveExperience(
  req: JobRequirement,
  profile: CandidateProfile,
): RequirementVerdict | null {
  const reqText = req.text.value;
  if (reqText === null) return null;
  const minYears = parseMinYears(reqText);
  if (minYears === null) return null;
  const years = profile.headline.total_years_experience;
  if (years.status === "unknown") {
    return verdict(
      req,
      "unknown",
      [],
      "The profile is silent on total years of experience — the CV does not state them.",
    );
  }
  if (years.status !== "stated" || years.value === null) return null; // contradicted → LLM
  const evidence = [evidenceRef("headline.total_years_experience", years)];
  if (years.value >= minYears) {
    return verdict(
      req,
      "match",
      evidence,
      `Profile states ${years.value} years of experience, meeting the ${minYears}-year requirement.`,
    );
  }
  return verdict(
    req,
    "missing",
    evidence,
    `Requirement asks for ${minYears} years; the profile positively states ${years.value} years.`,
  );
}

/* ---------------- location / remote ---------------- */

function resolveLocation(req: JobRequirement, profile: CandidateProfile): RequirementVerdict | null {
  const reqText = req.text.value;
  if (reqText === null) return null;
  const norm = normalizeForMatch(reqText);
  // \b (not containsPhrase) so hyphenated forms like "remote-first" count.
  const mentionsRemote = /\bremote\b/.test(norm);
  const mentionsHybrid = /\bhybrid\b/.test(norm);

  if (mentionsRemote || mentionsHybrid) {
    const pref = profile.location.remote_preference;
    if (pref.status === "unknown") {
      return verdict(
        req,
        "unknown",
        [],
        "The profile is silent on the candidate's remote-work preference.",
      );
    }
    if (pref.status !== "stated" || pref.value === null) return null;
    const evidence = [evidenceRef("location.remote_preference", pref)];
    if (mentionsRemote && !mentionsHybrid) {
      if (pref.value === "remote" || pref.value === "any") {
        return verdict(
          req,
          "match",
          evidence,
          `Requirement is remote; the profile states remote preference "${pref.value}".`,
        );
      }
      if (pref.value === "onsite") {
        return verdict(
          req,
          "missing",
          evidence,
          "Requirement is remote; the profile positively states an onsite-only preference.",
        );
      }
      return null; // hybrid preference vs remote job — fuzzy, LLM decides
    }
    // Hybrid requirement: only the clear fit is deterministic.
    if (pref.value === "hybrid" || pref.value === "any") {
      return verdict(
        req,
        "match",
        evidence,
        `Requirement is hybrid; the profile states remote preference "${pref.value}".`,
      );
    }
    return null;
  }

  // On-site / named-place requirement: clear containment of the candidate's
  // stated location (full string or a comma-separated part, e.g. "berlin").
  const current = profile.location.current;
  if (current.status === "unknown") {
    return verdict(
      req,
      "unknown",
      [],
      "The profile is silent on the candidate's current location.",
    );
  }
  if (current.status !== "stated" || current.value === null) return null;
  const places = [current.value, ...current.value.split(",")]
    .map((p) => normalizeForMatch(p))
    .filter((p) => p.length > 0);
  for (const place of places) {
    if (containsPhrase(norm, place)) {
      return verdict(
        req,
        "match",
        [evidenceRef("location.current", current)],
        `Requirement mentions "${current.value}"; the profile states it as the current location.`,
      );
    }
  }
  // Different named place: relocation/commute is a judgment call → LLM.
  return null;
}

/* ---------------- languages ---------------- */

/** Canonical spoken-language names; keys are normalizeForMatch-folded tokens. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  english: "english",
  german: "german",
  deutsch: "german",
  french: "french",
  francais: "french",
  "français": "french",
  spanish: "spanish",
  espanol: "spanish",
  "español": "spanish",
  russian: "russian",
  ukrainian: "ukrainian",
  italian: "italian",
  portuguese: "portuguese",
  portugues: "portuguese",
  "português": "portuguese",
  dutch: "dutch",
  nederlands: "dutch",
  polish: "polish",
  czech: "czech",
  slovak: "slovak",
  swedish: "swedish",
  norwegian: "norwegian",
  danish: "danish",
  finnish: "finnish",
  greek: "greek",
  turkish: "turkish",
  arabic: "arabic",
  hebrew: "hebrew",
  hindi: "hindi",
  chinese: "chinese",
  mandarin: "chinese",
  japanese: "japanese",
  korean: "korean",
};

const LEVEL_RANK: Record<LanguageLevel, number> = {
  basic: 1,
  professional: 2,
  fluent: 3,
  native: 4,
};

/** Level explicitly demanded by the requirement text, if any. */
function parseRequiredLevel(norm: string): LanguageLevel | null {
  if (/\bnative\b/.test(norm)) return "native";
  if (/\b(c1|c2|fluent|fluency|proficient)\b/.test(norm)) return "fluent";
  if (/\b(b1|b2|professional|intermediate|working proficiency)\b/.test(norm)) {
    return "professional";
  }
  if (/\b(a1|a2|basic|conversational)\b/.test(norm)) return "basic";
  return null;
}

function languageTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length > 0);
}

/** Canonical language names mentioned in a text, in first-seen order. */
function detectLanguages(text: string): string[] {
  const found = new Set<string>();
  for (const token of languageTokens(text)) {
    const lang = LANGUAGE_ALIASES[token];
    if (lang !== undefined) found.add(lang);
  }
  return [...found];
}

/**
 * The spec's canonical UNKNOWN-vs-MISSING example (§FR-7):
 *  - languages listed (stated) and the required language absent → 'missing'
 *    (the space is positively covered);
 *  - profile.languages empty / no stated entries → 'unknown' (silence).
 */
function resolveLanguage(req: JobRequirement, profile: CandidateProfile): RequirementVerdict | null {
  const reqText = req.text.value;
  if (reqText === null) return null;
  const norm = normalizeForMatch(reqText);
  const wanted = detectLanguages(reqText);
  const language = wanted.length === 1 ? wanted[0] : undefined;
  if (language === undefined) return null; // none detected, or ambiguous multi-language → LLM

  const stated = profile.languages
    .map((entry, index) => ({ entry, index }))
    .filter(
      (x): x is { entry: ProfileLanguage; index: number } =>
        x.entry.language.status === "stated" && x.entry.language.value !== null,
    );
  if (stated.length === 0) {
    return verdict(
      req,
      "unknown",
      [],
      "The profile is silent on languages — the CV does not list any.",
    );
  }

  const hit = stated.find((x) =>
    x.entry.language.value !== null && detectLanguages(x.entry.language.value).includes(language),
  );
  if (hit === undefined) {
    const listed = stated
      .map((x) => x.entry.language.value)
      .filter((v): v is string => v !== null)
      .join(", ");
    return verdict(
      req,
      "missing",
      stated.map((x) => evidenceRef(`languages[${x.index}].language`, x.entry.language)),
      `Profile lists languages (${listed}); the required ${language} is not among them.`,
    );
  }

  const evidence = [evidenceRef(`languages[${hit.index}].language`, hit.entry.language)];
  const requiredLevel = parseRequiredLevel(norm);
  if (requiredLevel === null) {
    // JD names no level — the language being stated at any level resolves it.
    return verdict(
      req,
      "match",
      evidence,
      `Profile states ${language}, which the requirement names without a level.`,
    );
  }
  const level = hit.entry.level;
  if (level.status !== "stated" || level.value === null) {
    // Presence is known but adequacy is not — fuzzy, LLM decides.
    return null;
  }
  evidence.push(evidenceRef(`languages[${hit.index}].level`, level));
  if (LEVEL_RANK[level.value] >= LEVEL_RANK[requiredLevel]) {
    return verdict(
      req,
      "match",
      evidence,
      `Profile states ${language} at "${level.value}", meeting the required ${requiredLevel}.`,
    );
  }
  return verdict(
    req,
    "missing",
    evidence,
    `Requirement demands ${language} at ${requiredLevel}; the profile positively states "${level.value}".`,
  );
}

/* ---------------- education ---------------- */

interface DegreeRequirement {
  rank: number;
  label: string;
}

/** Highest degree rank demanded by a text (1 bachelor, 2 master/MBA, 3 PhD). */
function parseDegreeRank(norm: string): DegreeRequirement | null {
  if (/\b(phd|ph\.d|doctorate|doctoral)\b/.test(norm)) return { rank: 3, label: "PhD" };
  if (/\b(mba|masters?|msc|m\.sc)\b/.test(norm)) return { rank: 2, label: "Master's degree" };
  if (/\b(bachelors?|bsc|b\.sc|beng|bs)\b/.test(norm)) {
    return { rank: 1, label: "Bachelor's degree" };
  }
  if (/\b(university degree|degree)\b/.test(norm)) return { rank: 1, label: "degree" };
  return null;
}

/**
 * Clear cases only: the requirement names a degree level AND every stated
 * education entry parses to a rank. Anything else (no degree keyword,
 * unparseable degree titles) → null for the LLM. An empty/all-unknown
 * education array is silence → 'unknown', never 'missing'.
 */
function resolveEducation(
  req: JobRequirement,
  profile: CandidateProfile,
): RequirementVerdict | null {
  const reqText = req.text.value;
  if (reqText === null) return null;
  const required = parseDegreeRank(normalizeForMatch(reqText));
  if (required === null) return null;

  const stated = profile.education
    .map((entry, index) => ({ entry, index }))
    .filter((x) => x.entry.degree.status === "stated" && x.entry.degree.value !== null);
  if (stated.length === 0) {
    return verdict(
      req,
      "unknown",
      [],
      "The profile is silent on education — the CV does not list any.",
    );
  }

  let best: { rank: number; index: number } | null = null;
  for (const x of stated) {
    if (x.entry.degree.value === null) continue;
    const rank = parseDegreeRank(normalizeForMatch(x.entry.degree.value));
    if (rank === null) return null; // unparseable stated degree — fuzzy → LLM
    if (best === null || rank.rank > best.rank) {
      best = { rank: rank.rank, index: x.index };
    }
  }
  if (best === null) return null;
  const bestEntry = stated.find((x) => x.index === best.index);
  if (bestEntry === undefined) return null;
  const evidence = [evidenceRef(`education[${best.index}].degree`, bestEntry.entry.degree)];
  if (best.rank >= required.rank) {
    return verdict(
      req,
      "match",
      evidence,
      `Profile states "${bestEntry.entry.degree.value ?? ""}", satisfying the ${required.label} requirement.`,
    );
  }
  return verdict(
    req,
    "missing",
    evidence,
    `Requirement asks for a ${required.label}; the profile's highest stated degree is "${bestEntry.entry.degree.value ?? ""}".`,
  );
}

/* ---------------- public API ---------------- */

/**
 * Resolve one requirement by deterministic rule, or return null when the
 * requirement must go to the LLM pass. Only 'skill', 'experience',
 * 'location', 'language' and 'education' categories have rules; 'industry'
 * and 'other' always go to the LLM.
 */
export function resolveRequirement(
  req: JobRequirement,
  profile: CandidateProfile,
): RequirementVerdict | null {
  if (req.text.status !== "stated" || req.text.value === null) return null;
  switch (req.category) {
    case "skill":
      return resolveSkill(req, profile);
    case "experience":
      return resolveExperience(req, profile);
    case "location":
      return resolveLocation(req, profile);
    case "language":
      return resolveLanguage(req, profile);
    case "education":
      return resolveEducation(req, profile);
    default:
      return null;
  }
}

export interface PrepassResult {
  /** Verdicts fully decided by rule — these never reach the LLM. */
  resolved: RequirementVerdict[];
  /** Requirements the pre-pass could not decide; input for match-requirements.v1. */
  unresolved: JobRequirement[];
}

/** Run the deterministic pre-pass over a requirement list (spec §FR-7 step 1). */
export function resolveBatch(
  requirements: readonly JobRequirement[],
  profile: CandidateProfile,
): PrepassResult {
  const resolved: RequirementVerdict[] = [];
  const unresolved: JobRequirement[] = [];
  for (const req of requirements) {
    const v = resolveRequirement(req, profile);
    if (v !== null) resolved.push(v);
    else unresolved.push(req);
  }
  return { resolved, unresolved };
}
