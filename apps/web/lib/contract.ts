/**
 * Frontend-local API contract types.
 *
 * These shapes are NOT in `@offerly/types` yet (its DTO surface is
 * intentionally minimal — see decisions.md). They describe the JSON the web
 * app expects from the plan §3 endpoints; the backend agent should treat them
 * as the contract. If the backend diverges, only this file changes.
 */

import type {
  AiConversation,
  CandidateProfile,
  CandidateProfileRow,
  Cv,
  CvAnalysis,
  CvImprovement as CvImprovementRecord,
  JobMatch,
  MatchRecommendation,
  MatchReportV2,
  RequirementCategory,
  RequirementImportance,
} from "@offerly/types";

/* ---------- CV Analyzer ---------- */

export interface CvSectionFeedback {
  name: string; // e.g. "Impact", "Clarity", "Keywords", "Formatting"
  score: number; // 0–100
  feedback: string;
}

export interface CvImprovement {
  priority: number; // 1 = most important
  title: string;
  detail: string;
  /**
   * cv-review.v2 (spec 003 T4.1): profile field path this improvement
   * concerns (e.g. "roles[0].scope"). Optional/additive — absent on old rows
   * and whenever no single field applies.
   */
  field_ref?: string;
}

/** Shape of `CvAnalysis.result` (jsonb). */
export interface CvAnalysisResult {
  sections: CvSectionFeedback[];
  improvements: CvImprovement[];
  /** True when the CV exceeded the input cap and was truncated (plan §8.4). */
  truncated: boolean;
  truncated_note?: string;
  /** Set when the CV is not in English (spec §5.2). */
  language_warning?: string;
}

export type CvAnalysisWithResult = Omit<CvAnalysis, "result"> & {
  result: CvAnalysisResult;
};

/* ---------- CV Improvements (spec 003 §FR-12/§FR-13, T5.3) ---------- */

/** Sentence-rewrite categories (mirror of sentence-rewrite.schema.ts). */
export type SentenceImprovementCategory =
  | "vague_responsibility"
  | "missing_action_verb"
  | "missing_outcome"
  | "first_person"
  | "paragraph_should_be_bullets"
  | "filler_words"
  | "overlong_sentence";

/** Bullet-improve categories (mirror of bullet-improve.schema.ts). */
export type BulletImprovementCategory =
  | "weak_action_verb"
  | "missing_metric"
  | "missing_impact"
  | "vague_wording";

export type ImprovementSuggestionStatus = "pending" | "accepted" | "rejected";

/**
 * One stored suggestion — model output plus the server-assigned id and
 * per-item status. Mirrors ImprovementSuggestion in cv-improvements.service.ts.
 */
export interface CvImprovementSuggestion {
  id: string;
  original_span: string;
  improved: string;
  reason: string;
  category: SentenceImprovementCategory | BulletImprovementCategory;
  status: ImprovementSuggestionStatus;
}

/** Shape of `CvImprovement.suggestions` (jsonb) for sentence/bullet rows. */
export interface CvImprovementsPayload {
  content_hash: string;
  depth: "basic" | "deep";
  truncated: boolean;
  /** Suggestions dropped by the verbatim-span / new-entity checks before storage. */
  dropped_count: number;
  items: CvImprovementSuggestion[];
}

/** GET /cvs/:id/improvements row with its jsonb column typed. */
export type CvImprovementRow = Omit<CvImprovementRecord, "suggestions" | "type"> & {
  type: "sentence" | "bullet";
  suggestions: CvImprovementsPayload;
};

/* ---------- CV Health (spec 003 §FR-14, T5.4/T5.5) ---------- */

/** Detector ids (mirror of HealthDetectorId in health/types.ts). */
export type HealthDetectorId =
  | "completeness"
  | "missing_keywords"
  | "duplicate_skills"
  | "tense_consistency"
  | "date_format_consistency"
  | "buzzwords"
  | "quantified_achievements"
  | "weak_summary"
  | "tech_adjacency"
  | "ats_format";

export type HealthSeverity = "info" | "warning";

/**
 * One stored health item — detector output plus the server-assigned id and
 * per-item status ('rejected' is the dismiss action). Mirrors HealthItem in
 * health/types.ts.
 */
export interface HealthItem {
  id: string;
  detector: HealthDetectorId;
  severity: HealthSeverity;
  title: string;
  detail: string;
  examples?: string[];
  status: ImprovementSuggestionStatus;
}

/** Shape of `CvImprovement.suggestions` (jsonb) for health rows. */
export interface HealthImprovementsPayload {
  content_hash: string;
  items: HealthItem[];
}

/** GET /cvs/:id/improvements health row with its jsonb column typed. */
export type CvHealthRow = Omit<CvImprovementRecord, "suggestions" | "type"> & {
  type: "health";
  suggestions: HealthImprovementsPayload;
};

/* ---------- CV upload (signed-URL flow, plan §9) ---------- */

/** POST /cvs with a file: request a signed upload URL. */
export interface CreateCvUploadRequest {
  filename: string;
  content_type: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  size_bytes: number;
  /** Free-tier replace flow (T12.1): owned CV to delete before creating. */
  replace_cv_id?: string;
}

/** POST /cvs with pasted text instead of a file. */
export interface CreateCvPasteRequest {
  text: string;
  replace_cv_id?: string;
}

export interface CreateCvUploadResponse {
  cv: Cv;
  /** Signed Supabase Storage URL the client PUTs the file to. */
  signed_url: string;
  path: string;
}

/* ---------- Candidate Profile (spec 003 §FR-1/§FR-2/§FR-3, T2.7) ---------- */

/** Pipeline stage names recorded in candidate_profiles.stage_meta. */
export type ProfilePipelineStage = "extracting" | "validating" | "persist";

/** Subset of candidate_profiles.stage_meta the UI reads (safe to display). */
export interface ProfileStageMeta {
  stages: { s1?: unknown; s2?: unknown; s3?: unknown };
  failed_stage?: ProfilePipelineStage;
  /** Sanitized error message — never contains CV text. */
  failure_reason?: string;
}

/** GET /cvs/:id/profile — the row with its jsonb columns typed. */
export type CandidateProfileWithData = Omit<
  CandidateProfileRow,
  "profile" | "stage_meta"
> & {
  profile: CandidateProfile;
  stage_meta: ProfileStageMeta | null;
};

/* ---------- Job Match ---------- */

/** Shape of `JobMatch.result` (jsonb). */
export interface JobMatchResult {
  strengths: string[];
  gaps: string[];
  recommendations: string[];
  /** True for short/vague JDs — UI warns instead of trusting the score. */
  low_confidence: boolean;
  confidence_note?: string;
}

export type JobMatchWithResult = Omit<JobMatch, "result"> & {
  result: JobMatchResult;
};

/**
 * Requirement snapshot stored inside the v2 report (spec 003 T3.5): verdicts
 * reference requirements by id only, and job_profiles is not exposed over the
 * API — the report itself carries the text/category/importance to render.
 * Mirrors `MatchRequirementSnapshot` in apps/api/src/modules/jobs/match.service.ts.
 */
export interface MatchRequirementSnapshot {
  id: string;
  text: string;
  category: RequirementCategory;
  importance: RequirementImportance;
}

/** Shape of `JobMatch.result` v2 (spec 003 §FR-8) as stored by the API. */
export interface StoredMatchResultV2 extends MatchReportV2 {
  requirements: MatchRequirementSnapshot[];
  /**
   * recommendations.v1 next actions (spec 003 T4.2), computed and stored with
   * the report. Optional — absent on pre-T4.2 rows and degraded computes.
   */
  recommendations?: MatchRecommendation[];
  jd_low_confidence: boolean;
  warning?: string;
  profile_version: number;
  profile_content_hash: string;
  job_content_hash: string;
}

export type JobMatchWithResultV2 = Omit<JobMatch, "result"> & {
  result: StoredMatchResultV2;
};

/** A match row of either generation — narrow with `isMatchResultV2`. */
export type JobMatchAnyResult = JobMatchWithResult | JobMatchWithResultV2;

/** v2 reports carry `version: 2`; v1 rows have strengths/gaps instead. */
export function isMatchResultV2(match: JobMatchAnyResult): match is JobMatchWithResultV2 {
  return (
    typeof match.result === "object" &&
    match.result !== null &&
    (match.result as { version?: unknown }).version === 2
  );
}

/* ---------- Apply Assistant ---------- */

export interface ApplyAnswer {
  question: string;
  answer: string;
}

/** POST /jobs/:id/apply response. */
export interface ApplyGeneration {
  cover_letter: string;
  answers: ApplyAnswer[];
  recommendations: string[];
  /** Gaps the assistant refused to fabricate (spec §5.4 honesty rule). */
  gaps_flagged: string[];
  /** True for the free-tier watermarked sample generation. */
  sample: boolean;
}

/* ---------- Coach ---------- */

/** POST /coach/conversations */
export interface CreateConversationRequest {
  kind: "coach";
  context?: { cv_id?: string; job_id?: string };
}

/**
 * SSE events streamed by POST /coach/conversations/:id/messages.
 * Each event is sent as `event: <type>` + `data: <json>`.
 */
export type CoachStreamEvent =
  | { type: "token"; content: string }
  | { type: "notice"; content: string } // e.g. context compaction notice
  | { type: "done"; message_id?: string }
  | { type: "error"; message: string };

export type CoachConversation = AiConversation;

/* ---------- Billing ---------- */

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

/* ---------- Paywall (402 payload) ---------- */

/** Structured body the API returns with HTTP 402 (plan §6, tasks T10.2). */
export interface UpgradeRequiredPayload {
  error: string; // machine code, e.g. "quota_exceeded" | "feature_locked"
  message?: string; // human-readable
  feature?: string; // e.g. "coach", "apply_assistant", "cv_analysis"
  plan_required?: "pro";
  limit?: number;
  used?: number;
}
