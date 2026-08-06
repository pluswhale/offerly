/**
 * Database row types — mirrors plan.md §2 and supabase/migrations/.
 * `jsonb` columns are typed as `unknown` on rows; narrower result shapes
 * belong to the AI module that produces them, not to the shared row type.
 */

export interface SalaryExpectation {
  amount: number;
  currency: string;
  period: "year" | "month" | "hour";
}

export interface Profile {
  id: string; // uuid, 1:1 with auth.users.id
  full_name: string | null;
  current_role: string | null;
  target_role: string | null;
  experience_level: string | null;
  location: string | null;
  visa_status: string | null;
  salary_expectation: SalaryExpectation | null;
  user_goals: UserGoals | null; // spec 003 §FR-11, progressive profiling
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

/** Coach context-manifest goals (spec 003 §FR-11) — collected inline, never blocking. */
export interface UserGoals {
  target_location: string | null;
  target_salary: SalaryExpectation | null;
  priority: string | null;
}

export interface Cv {
  id: string;
  user_id: string;
  name: string; // user-facing label: filename for uploads, "Pasted CV" otherwise
  file_path: string | null; // Supabase Storage path, null if pasted
  extracted_text: string | null;
  content_hash: string | null; // sha256 of normalized text
  is_active: boolean;
  created_at: string;
}

export type AnalysisDepth = "basic" | "deep";

export interface CvAnalysis {
  id: string;
  cv_id: string;
  user_id: string;
  score: number; // 0–100
  result: unknown; // sections, improvements, model version
  depth: AnalysisDepth;
  created_at: string;
}

export interface Job {
  id: string;
  user_id: string;
  title: string;
  company: string | null;
  url: string | null;
  description_text: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface JobMatch {
  id: string;
  user_id: string;
  cv_id: string;
  job_id: string;
  score: number; // 0–100
  result: unknown; // strengths, gaps, recommendations
  created_at: string;
}

export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interview",
  "offer",
  "rejected",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  id: string;
  user_id: string;
  job_id: string | null; // manual entries allowed
  company: string;
  role: string;
  status: ApplicationStatus;
  applied_at: string | null;
  notes: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export type ConversationKind = "coach" | "apply_assistant";

export interface AiConversation {
  id: string;
  user_id: string;
  kind: ConversationKind;
  context: unknown; // linked cv_id/job_id
  created_at: string;
}

export type MessageRole = "user" | "assistant" | "system-summary";

export interface AiMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  token_count: number | null;
  created_at: string;
}

export type SubscriptionPlan = "free" | "pro";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "trialing";

export interface Subscription {
  id: string;
  user_id: string;
  provider: string | null; // "stripe" (future: "crypto")
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  plan: SubscriptionPlan;
  status: SubscriptionStatus | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export type UsageOperation =
  | "cv_analysis"
  | "job_match"
  | "apply_generate"
  | "coach_message"
  | "cv_profile"
  | "jd_extract"
  | "match_requirements"
  | "cv_improve";

export interface UsageRecord {
  id: string;
  user_id: string;
  operation: UsageOperation;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_microcents: number | null;
  cache_hit: boolean;
  created_at: string;
}

export interface LlmCacheEntry {
  cache_key: string; // sha256(template_version + normalized input)
  response: unknown;
  created_at: string;
}

/** spec 003 §FR-1: pipeline status, recorded on the candidate_profiles row. */
export type CandidateProfileStatus = "extracting" | "validating" | "ready" | "failed";

/** spec 003 T1.2 — `profile` holds a CandidateProfile (ai-profiles.ts). */
export interface CandidateProfileRow {
  id: string;
  user_id: string;
  cv_id: string;
  version: number;
  status: CandidateProfileStatus;
  profile: unknown; // CandidateProfile, validated server-side at the AI boundary
  stage_meta: unknown; // per-stage: template version, tokens, duration, flags
  created_at: string;
  updated_at: string;
}

/** spec 003 §FR-5 — `profile` holds a JobProfile (ai-profiles.ts). */
export interface JobProfileRow {
  id: string;
  job_id: string;
  profile: unknown; // JobProfile, validated server-side at the AI boundary
  template_version: string;
  /** jobs.content_hash the profile was extracted from; mismatch → re-extract (spec §FR-5). */
  content_hash: string;
  created_at: string;
}

export type CvImprovementType = "sentence" | "bullet" | "health";

/** spec 003 §FR-12/§FR-14 — suggestions carry per-item pending|accepted|rejected. */
export interface CvImprovement {
  id: string;
  cv_id: string;
  user_id: string;
  type: CvImprovementType;
  suggestions: unknown;
  template_version: string | null;
  created_at: string;
}
