import { Injectable } from "@nestjs/common";
import { PLAN_LIMITS, type SubscriptionPlan } from "@offerly/types";
import { SupabaseService } from "../supabase/supabase.service.js";
import type { GatedFeature } from "./requires.decorator.js";

export interface GateContext {
  cvId?: string;
  jobId?: string;
  /** Request body (used by application_modify to allow archiving). */
  body?: unknown;
}

export interface GateDenial {
  feature: GatedFeature;
  reason: string;
}

/** Operations that count toward the monthly free AI quota (task T10.2). */
const QUOTA_OPERATIONS = ["cv_analysis", "job_match"] as const;

/**
 * Server-side plan enforcement (T10.2, plan §6). PLAN_LIMITS from
 * @offerly/types is the single source of truth; quota = count of
 * non-cache-hit usage_records this calendar month.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly supabase: SupabaseService) {}

  async getPlan(userId: string, token: string): Promise<SubscriptionPlan> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("subscriptions")
      .select("plan, status")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { plan: string; status: string | null } | null;
    if (row?.plan === "pro" && (row.status === "active" || row.status === "trialing")) {
      return "pro";
    }
    return "free";
  }

  /** Monthly AI quota usage: non-cache-hit cv_analysis + job_match this month. */
  async getMonthlyAiCount(userId: string, token: string): Promise<number> {
    const db = this.supabase.forUser(token);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await db
      .from("usage_records")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("cache_hit", false)
      .in("operation", [...QUOTA_OPERATIONS])
      .gte("created_at", monthStart.toISOString());
    return count ?? 0;
  }

  /** Returns null when access is allowed, a GateDenial otherwise. */
  async checkAccess(
    userId: string,
    token: string,
    feature: GatedFeature,
    ctx: GateContext = {},
  ): Promise<GateDenial | null> {
    const plan = await this.getPlan(userId, token);
    const limits = PLAN_LIMITS[plan];
    const db = this.supabase.forUser(token);

    switch (feature) {
      case "cv_create": {
        // Replace flow keeps the stored count unchanged — always allowed.
        const body = ctx.body as { replace_cv_id?: string } | undefined;
        if (body?.replace_cv_id) return null;
        const { count } = await db
          .from("cvs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId);
        if ((count ?? 0) >= limits.storedCvs) {
          return {
            feature,
            reason: `Free plan stores ${limits.storedCvs} CV — replace it or upgrade to Pro for unlimited CVs`,
          };
        }
        return null;
      }

      case "coach": {
        if (!limits.coach) {
          return { feature, reason: "The AI coach is a Pro feature" };
        }
        return null;
      }

      case "apply_generate": {
        if (limits.applyAssistant === "full") return null;
        // Free = "sample": one generation ever, then 402.
        const { count } = await db
          .from("usage_records")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("operation", "apply_generate")
          .eq("cache_hit", false);
        if ((count ?? 0) >= 1) {
          return {
            feature,
            reason: "Free plan includes one sample application generation",
          };
        }
        return null;
      }

      case "application_create": {
        const { count } = await db
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("archived", false);
        if ((count ?? 0) >= limits.activeApplications) {
          return {
            feature,
            reason: `Free plan allows ${limits.activeApplications} active applications — archive some or upgrade`,
          };
        }
        return null;
      }

      case "application_modify": {
        // Downgrade rule (spec §6): over-limit entries become read-only.
        // Archiving is always allowed (it reduces the count).
        const body = ctx.body as { archived?: boolean } | undefined;
        if (body?.archived === true) return null;
        const { count } = await db
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("archived", false);
        if ((count ?? 0) > limits.activeApplications) {
          return {
            feature,
            reason:
              "Your plan is over the application limit — entries are read-only until you archive some or upgrade",
          };
        }
        return null;
      }

      case "cv_analysis": {
        // Re-analyzing a CV that already has an analysis is a guaranteed
        // cache hit (cv rows are immutable) — always free (T5.3).
        if (ctx.cvId) {
          const { count } = await db
            .from("cv_analyses")
            .select("id", { count: "exact", head: true })
            .eq("cv_id", ctx.cvId);
          if ((count ?? 0) > 0) return null;
        }
        const { count: analyses } = await db
          .from("cv_analyses")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId);
        if ((analyses ?? 0) >= limits.cvAnalyses) {
          return {
            feature,
            reason: `Free plan includes ${limits.cvAnalyses} CV analysis`,
          };
        }
        return this.checkMonthlyQuota(userId, token, feature, limits.aiRequestsPerMonth);
      }

      case "job_match": {
        // An existing match for this job + the active CV is a cache hit — free.
        if (ctx.jobId) {
          const { data: cv } = await db
            .from("cvs")
            .select("id")
            .eq("user_id", userId)
            .eq("is_active", true)
            .limit(1)
            .maybeSingle();
          if (!cv) return null; // endpoint responds with the upload prompt
          const { count } = await db
            .from("job_matches")
            .select("id", { count: "exact", head: true })
            .eq("job_id", ctx.jobId)
            .eq("cv_id", (cv as { id: string }).id);
          if ((count ?? 0) > 0) return null;
        }
        return this.checkMonthlyQuota(userId, token, feature, limits.aiRequestsPerMonth);
      }
    }
  }

  private async checkMonthlyQuota(
    userId: string,
    token: string,
    feature: GatedFeature,
    limit: number,
  ): Promise<GateDenial | null> {
    const used = await this.getMonthlyAiCount(userId, token);
    if (used >= limit) {
      return {
        feature,
        reason: `Free plan includes ${limit} AI requests per month (${used} used)`,
      };
    }
    return null;
  }
}
