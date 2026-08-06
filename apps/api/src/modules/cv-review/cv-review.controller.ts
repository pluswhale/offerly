import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { PLAN_LIMITS, type CvAnalysis } from "@offerly/types";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { CvReviewService } from "./cv-review.service.js";

/**
 * CV quality review endpoints (spec 003 §FR-9, T4.1). Same routes and gating
 * as the v1 analysis; the orchestration moved here because the review now
 * depends on the candidate-profiles pipeline (module boundary: cvs must not
 * import candidate-profiles — candidate-profiles already imports cvs).
 */
@Controller("cvs")
export class CvReviewController {
  constructor(
    private readonly review: CvReviewService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post(":id/analyze")
  @UseGuards(EntitlementGuard)
  @Requires("cv_analysis")
  async analyze(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CvAnalysis> {
    const plan = await this.entitlements.getPlan(userId, token);
    return this.review.analyze(userId, token, id, PLAN_LIMITS[plan].matchDepth);
  }

  @Get(":id/analyses")
  listAnalyses(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CvAnalysis[]> {
    return this.review.listAnalyses(userId, token, id);
  }
}
