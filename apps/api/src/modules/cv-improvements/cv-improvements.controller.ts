import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PLAN_LIMITS, type CvImprovement } from "@offerly/types";
import { IsIn, IsUUID } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { Requires } from "../entitlements/requires.decorator.js";
import {
  CvImprovementsService,
  type ImprovementSuggestionStatus,
} from "./cv-improvements.service.js";

class UpdateSuggestionDto {
  @IsUUID()
  suggestion_id!: string;

  @IsIn(["accepted", "rejected"])
  status!: Exclude<ImprovementSuggestionStatus, "pending">;
}

/**
 * CV improvement endpoints (spec 003 §FR-12/§FR-13/§FR-14, T5.1/T5.2/T5.4).
 * Gating mirrors the CV analysis (@Requires('cv_analysis'),
 * free=basic/pro=deep via matchDepth) — spec §11: new operations fold into
 * the existing plan structure. GET/PATCH are ungated, same as the analyses
 * list.
 *
 * Note on 'health' (T5.4): it keeps the same gate for consistency, but it
 * is pure code — no LLM call, no usage_records row — so it never consumes
 * the monthly AI quota (the quota counts usage_records ops; see
 * entitlements.service.ts QUOTA_OPERATIONS).
 */
@Controller("cvs")
export class CvImprovementsController {
  constructor(
    private readonly improvements: CvImprovementsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post(":id/improvements")
  @UseGuards(EntitlementGuard)
  @Requires("cv_analysis")
  async generate(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("type") type?: string,
  ): Promise<CvImprovement> {
    const kind = type ?? "sentence";
    if (kind !== "sentence" && kind !== "bullet" && kind !== "health") {
      throw new BadRequestException("type must be 'sentence', 'bullet' or 'health'");
    }
    // Health is deterministic — no plan-dependent depth, no LLM cost.
    if (kind === "health") {
      return this.improvements.generateHealth(userId, token, id);
    }
    const plan = await this.entitlements.getPlan(userId, token);
    const depth = PLAN_LIMITS[plan].matchDepth;
    return kind === "sentence"
      ? this.improvements.generateSentences(userId, token, id, depth)
      : this.improvements.generateBullets(userId, token, id, depth);
  }

  @Get(":id/improvements")
  list(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CvImprovement[]> {
    return this.improvements.list(userId, token, id);
  }

  @Patch(":id/improvements/:rowId")
  updateSuggestionStatus(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("rowId", ParseUUIDPipe) rowId: string,
    @Body() dto: UpdateSuggestionDto,
  ): Promise<CvImprovement> {
    return this.improvements.updateSuggestionStatus(
      userId,
      token,
      id,
      rowId,
      dto.suggestion_id,
      dto.status,
    );
  }
}
