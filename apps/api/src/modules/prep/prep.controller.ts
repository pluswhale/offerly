import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { PrepService, type InterviewPrepResponse } from "./prep.service.js";

/**
 * Interview prep (spec 004). A second controller on the "applications" base
 * path keeps ApplicationsController untouched (spec §9).
 */
@Controller("applications")
export class PrepController {
  constructor(private readonly prepService: PrepService) {}

  @Post(":id/interview-prep")
  @UseGuards(EntitlementGuard)
  @Requires("interview_prep")
  prep(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<InterviewPrepResponse> {
    return this.prepService.generate(userId, token, id);
  }
}
