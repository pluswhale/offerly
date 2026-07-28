import type { SalaryExpectation, SubscriptionPlan } from "./db.js";

/** Health check response (GET /health). */
export interface HealthResponse {
  status: "ok";
}

/** PATCH /profiles/me — all fields optional (progressive profiling). */
export interface UpdateProfileRequest {
  full_name?: string;
  current_role?: string;
  target_role?: string;
  experience_level?: string;
  location?: string;
  visa_status?: string;
  salary_expectation?: SalaryExpectation;
  onboarding_completed?: boolean;
}

/** POST /jobs */
export interface CreateJobRequest {
  title: string;
  company?: string;
  url?: string;
  description_text: string;
}

/** POST /applications — manual entry (job_id optional) or from a job. */
export interface CreateApplicationRequest {
  job_id?: string;
  company: string;
  role: string;
  status?: "saved" | "applied" | "interview" | "offer" | "rejected";
  applied_at?: string;
  notes?: string;
}

/** PATCH /applications/:id */
export interface UpdateApplicationRequest {
  company?: string;
  role?: string;
  status?: "saved" | "applied" | "interview" | "offer" | "rejected";
  applied_at?: string | null;
  notes?: string | null;
  archived?: boolean;
}

/** GET /usage/me — quota display on the dashboard (UX hint only). */
export interface UsageSummary {
  plan: SubscriptionPlan;
  ai_requests_this_month: number;
  limits: {
    ai_requests_per_month: number; // Infinity serialized by the API as -1
    cv_analyses: number;
    active_applications: number;
  };
}

/** POST /coach/conversations/:id/messages */
export interface SendCoachMessageRequest {
  content: string;
}

/** POST /jobs/:id/apply — optional regeneration instruction. */
export interface GenerateApplicationRequest {
  instruction?: string;
}
