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
  Cv,
  CvAnalysis,
  JobMatch,
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

/* ---------- CV upload (signed-URL flow, plan §9) ---------- */

/** POST /cvs with a file: request a signed upload URL. */
export interface CreateCvUploadRequest {
  filename: string;
  content_type: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  size_bytes: number;
}

/** POST /cvs with pasted text instead of a file. */
export interface CreateCvPasteRequest {
  text: string;
}

export interface CreateCvUploadResponse {
  cv: Cv;
  /** Signed Supabase Storage URL the client PUTs the file to. */
  signed_url: string;
  path: string;
}

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
