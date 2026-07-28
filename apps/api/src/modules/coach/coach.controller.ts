import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { AiConversation, AiMessage, SendCoachMessageRequest } from "@offerly/types";
import type { Response } from "express";
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { CoachService } from "./coach.service.js";

class CreateConversationDto {
  @IsOptional()
  @IsIn(["coach"])
  kind?: "coach";

  @IsOptional()
  @IsUUID()
  job_id?: string;
}

class SendMessageDto implements SendCoachMessageRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  content!: string;
}

@Controller("coach/conversations")
@UseGuards(EntitlementGuard)
export class CoachController {
  constructor(private readonly coach: CoachService) {}

  @Post()
  @Requires("coach")
  create(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: CreateConversationDto,
  ): Promise<AiConversation> {
    return this.coach.createConversation(userId, token, dto.job_id);
  }

  /** History for a resumed conversation; read-only, no entitlement gate. */
  @Get(":id/messages")
  listMessages(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<AiMessage[]> {
    return this.coach.listMessages(userId, token, id);
  }

  /** SSE stream (T9.1): token events, then a done (or error) event. */
  @Post(":id/messages")
  @Requires("coach")
  async sendMessage(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    const { events } = await this.coach.prepareMessage(userId, token, id, dto.content);

    res.status(200);
    res.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();
    try {
      for await (const event of events) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const frame = { type: "error", message: err instanceof Error ? err.message : "stream failed" };
      res.write(`event: error\ndata: ${JSON.stringify(frame)}\n\n`);
    } finally {
      res.end();
    }
  }
}
