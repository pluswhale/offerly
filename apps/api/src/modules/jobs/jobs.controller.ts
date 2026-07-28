import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import type { CreateJobRequest, Job } from "@offerly/types";
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { JobsService } from "./jobs.service.js";

class CreateJobDto implements CreateJobRequest {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  company?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  url?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  description_text!: string;
}

@Controller("jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: CreateJobDto,
  ): Promise<Job> {
    return this.jobs.create(userId, token, dto);
  }

  @Get(":id")
  get(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Job> {
    return this.jobs.getOwned(userId, token, id);
  }
}
