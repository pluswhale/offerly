import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { GenerateApplicationRequest, JobMatch } from "@offerly/types";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { ApplyService, type ApplyResponse } from "./apply.service.js";
import { MatchService } from "./match.service.js";

class GenerateApplicationDto implements GenerateApplicationRequest {
  /** Regeneration instruction, e.g. "shorter", "more formal" (T7.1). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instruction?: string;
}

/** Job-scoped AI features: match scoring (T6.2) and apply generation (T7.1). */
@Controller("jobs")
export class JobAiController {
  constructor(
    private readonly matchService: MatchService,
    private readonly applyService: ApplyService,
  ) {}

  @Post(":id/match")
  @UseGuards(EntitlementGuard)
  @Requires("job_match")
  match(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<JobMatch> {
    return this.matchService.match(userId, token, id);
  }

  @Get(":id/match")
  getMatch(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<JobMatch> {
    return this.matchService.getLatest(userId, token, id);
  }

  @Post(":id/apply")
  @UseGuards(EntitlementGuard)
  @Requires("apply_generate")
  apply(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: GenerateApplicationDto,
  ): Promise<ApplyResponse> {
    return this.applyService.generate(userId, token, id, dto);
  }
}
