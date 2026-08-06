import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { CandidateProfileRow, RunCandidateProfileResponse } from "@offerly/types";
import { IsDefined, IsString, MaxLength, MinLength } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { ProfilePipelineService } from "./profile-pipeline.service.js";

class CorrectProfileDto {
  /** Verifier-style field path, e.g. "skills.databases[0]" (spec 003 §FR-4). */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  path!: string;

  /** The user's statement — any JSON value matching the field's type. */
  @IsDefined()
  value!: unknown;
}

/**
 * Candidate Profile endpoints (spec 003 §FR-3/§FR-4, T2.4/T2.5). Nested under
 * /cvs/:id like the existing analysis endpoints; the pipeline runs async
 * in-process — POST returns 202, the client polls GET until ready|failed.
 */
@Controller("cvs")
export class CandidateProfilesController {
  constructor(private readonly pipeline: ProfilePipelineService) {}

  @Post(":id/profile")
  @UseGuards(EntitlementGuard)
  @Requires("cv_analysis")
  async run(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RunCandidateProfileResponse | CandidateProfileRow> {
    const result = await this.pipeline.start(userId, token, id);
    // Idempotent reuse (spec §FR-3): 200 with the existing ready profile.
    if (result.reused) {
      res.status(200);
      return result.row;
    }
    res.status(202);
    return { profile_id: result.row.id, status: result.row.status };
  }

  @Get(":id/profile")
  get(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CandidateProfileRow> {
    return this.pipeline.getLatest(userId, token, id);
  }

  @Patch(":id/profile")
  correct(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CorrectProfileDto,
  ): Promise<CandidateProfileRow> {
    return this.pipeline.correct(userId, token, id, dto.path, dto.value);
  }
}
