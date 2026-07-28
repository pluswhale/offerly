import { Controller, Get } from "@nestjs/common";
import { PLAN_LIMITS, type UsageSummary } from "@offerly/types";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { Module } from "@nestjs/common";

/** GET /usage/me (T10.2): plan + monthly AI usage + limits for the dashboard. */
@Controller("usage")
export class UsageController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get("me")
  async me(@UserId() userId: string, @AccessToken() token: string): Promise<UsageSummary> {
    const [plan, aiCount] = await Promise.all([
      this.entitlements.getPlan(userId, token),
      this.entitlements.getMonthlyAiCount(userId, token),
    ]);
    const limits = PLAN_LIMITS[plan];
    // Infinity is not JSON-serializable; -1 means "unlimited" (dto contract).
    const serialize = (n: number): number => (n === Infinity ? -1 : n);
    return {
      plan,
      ai_requests_this_month: aiCount,
      limits: {
        ai_requests_per_month: serialize(limits.aiRequestsPerMonth),
        cv_analyses: serialize(limits.cvAnalyses),
        active_applications: serialize(limits.activeApplications),
      },
    };
  }
}

@Module({
  imports: [EntitlementsModule],
  controllers: [UsageController],
})
export class UsageModule {}
