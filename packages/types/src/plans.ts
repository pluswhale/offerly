import type { AnalysisDepth, SubscriptionPlan } from "./db.js";

export interface PlanLimits {
  aiRequestsPerMonth: number;
  cvAnalyses: number;
  storedCvs: number;
  activeApplications: number;
  applyAssistant: "sample" | "full";
  coach: boolean;
  matchDepth: AnalysisDepth;
}

/**
 * Single source of truth for feature gating (plan.md §6).
 * Enforcement is always server-side; the client reads these for UX hints only.
 * `Infinity` = unlimited.
 */
export const PLAN_LIMITS: Record<SubscriptionPlan, PlanLimits> = {
  free: {
    aiRequestsPerMonth: 5,
    cvAnalyses: 1,
    storedCvs: 1,
    activeApplications: 10,
    applyAssistant: "sample",
    coach: false,
    matchDepth: "basic",
  },
  pro: {
    aiRequestsPerMonth: Infinity,
    cvAnalyses: Infinity,
    storedCvs: Infinity,
    activeApplications: Infinity,
    applyAssistant: "full",
    coach: true,
    matchDepth: "deep",
  },
} as const;
