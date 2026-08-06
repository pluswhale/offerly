/**
 * AI pipeline domain types (spec 003 §FR-2/§FR-5/§FR-7/§FR-8).
 * Dependency-free plain TS — the mirrored zod validators live in
 * `apps/api/src/modules/ai/schemas/` (API boundary owns validation).
 */

/**
 * Every leaf fact extracted by the LLM is an Evidenced<T> (spec §FR-2).
 * `value: null` ⇔ UNKNOWN; omission of a field is a schema error, not an
 * implicit unknown — extraction must emit every field explicitly.
 */
export interface Evidenced<T> {
  value: T | null;
  status: EvidencedStatus;
  /** 0–1, model-reported, then clamped by the deterministic verifier (S2/S3). */
  confidence: number;
  /** Verbatim quote from the source document; null ⇔ UNKNOWN (or user-set). */
  evidence: string | null;
  /**
   * 'user' marks user corrections (spec §FR-4): stated, confidence 1.0,
   * evidence null — distinguishable forever from AI-extracted facts.
   */
  source?: FactSource;
}

export type EvidencedStatus = "stated" | "unknown" | "contradicted";

export type FactSource = "ai" | "user";

export type Seniority =
  | "junior"
  | "mid"
  | "senior"
  | "staff"
  | "lead"
  | "manager"
  | "executive";

export type LanguageLevel = "native" | "fluent" | "professional" | "basic";

export type RemotePolicy = "onsite" | "hybrid" | "remote" | "unknown";

export type RemotePreference = "onsite" | "hybrid" | "remote" | "any";

/** Skill with optional depth metadata (spec §FR-2). */
export interface EvidencedSkill extends Evidenced<string> {
  /** Years of experience with the skill, if the CV states it. */
  years?: number | null;
  /** Last role the skill appears in. */
  recency?: string | null;
}

export interface ProfileHeadline {
  title: Evidenced<string>;
  seniority: Evidenced<Seniority>;
  /** Derived from dated roles only — quoted, never guessed (spec §FR-2). */
  total_years_experience: Evidenced<number>;
}

export interface ProfileRole {
  title: Evidenced<string>;
  company: Evidenced<string>;
  /** Free-form date as written in the CV (e.g. "2021-03" or "Mar 2021"). */
  start: Evidenced<string>;
  /** Free-form date; "present" for current roles. */
  end: Evidenced<string>;
  industry: Evidenced<string>;
  /** Team size / responsibility scope. */
  scope: Evidenced<string>;
  /** Derived flag (end = present), not itself evidenced. */
  is_current: boolean;
}

export interface ProfileSkills {
  programming_languages: EvidencedSkill[];
  frameworks: EvidencedSkill[];
  cloud_platforms: EvidencedSkill[];
  databases: EvidencedSkill[];
  devops_tools: EvidencedSkill[];
  other_technologies: EvidencedSkill[];
  soft_skills: EvidencedSkill[];
}

export interface ProfileExperience {
  industries: Evidenced<string>[];
  /** Business domains, e.g. fintech, B2B SaaS. */
  domains: Evidenced<string>[];
  team_sizes_managed: Evidenced<number>;
  leadership: Evidenced<boolean>;
  leadership_scope: Evidenced<string>;
  management: Evidenced<boolean>;
  management_scope: Evidenced<string>;
}

export interface ProfileEducation {
  degree: Evidenced<string>;
  institution: Evidenced<string>;
  year: Evidenced<number>;
}

export interface ProfileCertification {
  name: Evidenced<string>;
  issuer: Evidenced<string>;
  year: Evidenced<number>;
}

export interface ProfileLanguage {
  language: Evidenced<string>;
  level: Evidenced<LanguageLevel>;
}

export interface ProfileLocation {
  current: Evidenced<string>;
  /** Citizenships / visas. */
  work_authorization: Evidenced<string>[];
  remote_preference: Evidenced<RemotePreference>;
}

/** The central artifact of the pipeline (spec §FR-2). */
export interface CandidateProfile {
  headline: ProfileHeadline;
  roles: ProfileRole[];
  skills: ProfileSkills;
  experience: ProfileExperience;
  education: ProfileEducation[];
  certifications: ProfileCertification[];
  languages: ProfileLanguage[];
  location: ProfileLocation;
  /**
   * Profile completeness 0–100, derived at persist time (S4) — NOT extracted
   * by the LLM, so the extraction schema must not require it.
   */
  summary_quality?: number;
}

export type RequirementImportance = "must_have" | "nice_to_have";

export type RequirementCategory =
  | "skill"
  | "experience"
  | "industry"
  | "location"
  | "language"
  | "education"
  | "other";

/** Normalized flat requirement entry (spec §FR-5); text is Evidenced vs the JD. */
export interface JobRequirement {
  id: string;
  text: Evidenced<string>;
  category: RequirementCategory;
  importance: RequirementImportance;
}

/** Structured job description (spec §FR-5). */
export interface JobProfile {
  required_skills: Evidenced<string>[];
  preferred_skills: Evidenced<string>[];
  min_years_experience: Evidenced<number>;
  industry: Evidenced<string>;
  location: Evidenced<string>;
  remote_policy: Evidenced<RemotePolicy>;
  languages: Evidenced<string>[];
  education_requirements: Evidenced<string>[];
  requirements: JobRequirement[];
}

export type VerdictValue = "match" | "partial" | "unknown" | "missing";

/** Per-requirement classification result (spec §FR-7). */
export interface RequirementVerdict {
  requirement_id: string;
  verdict: VerdictValue;
  confidence: number;
  /** References into the Candidate Profile (field paths + their quotes). */
  candidate_evidence: string[];
  /** One or two sentences, grounded in the evidence. */
  reasoning: string;
}

export type ScoreComponent =
  | "must_have"
  | "nice_to_have"
  | "experience"
  | "industry"
  | "location_remote"
  | "languages"
  | "education";

/** One component of the explainable score (spec §FR-8). */
export interface ComponentScore {
  /** 0–1 weight from the versioned weights config. */
  weight: number;
  /** 0–1 component score. */
  component_score: number;
  /** weight × component_score — sum over components = score / 100. */
  contribution: number;
}

export type ScoreBreakdown = Record<ScoreComponent, ComponentScore>;

/** One prioritized next action derived from a match report (spec §FR-10, T4.2). */
export interface MatchRecommendation {
  /** 1 = highest impact. */
  priority: number;
  /** The concrete action, e.g. "Add Docker to your CV with evidence of project X". */
  action: string;
  /** Why it matters for THIS job — grounded in the cited verdicts. */
  rationale: string;
  /** Requirement ids from the report's verdicts this action addresses. */
  requirement_refs: string[];
}

/** Stored match report, `job_matches.result` v2 (spec §FR-8). */
export interface MatchReportV2 {
  version: 2;
  score: number;
  weights_version: string;
  breakdown: ScoreBreakdown;
  verdicts: RequirementVerdict[];
  /** True when >40% of must-have weight is UNKNOWN (spec §FR-8 confidence gate). */
  low_confidence: boolean;
  /** Share of must-have requirements with verdict 'unknown' (0–1). */
  unknown_must_have_share: number;
  /** Template versions that produced this report, for reproducibility. */
  template_versions: Record<string, string>;
}
