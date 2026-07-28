import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  type CreateApplicationRequest,
  type UpdateApplicationRequest,
} from "@offerly/types";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { ApplicationsService } from "./applications.service.js";

const STATUSES = APPLICATION_STATUSES as readonly string[];

class CreateApplicationDto implements CreateApplicationRequest {
  @IsOptional()
  @IsUUID()
  job_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  company!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  role!: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ApplicationStatus;

  @IsOptional()
  @IsDateString()
  applied_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  notes?: string;
}

class UpdateApplicationDto implements UpdateApplicationRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  company?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  role?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ApplicationStatus;

  @IsOptional()
  @IsDateString()
  applied_at?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

class ListQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: string;

  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  archived?: boolean;
}

@Controller("applications")
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  list(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Query() query: ListQueryDto,
  ): Promise<Application[]> {
    return this.applications.list(userId, token, query);
  }

  @Post()
  @UseGuards(EntitlementGuard)
  @Requires("application_create")
  create(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: CreateApplicationDto,
  ): Promise<Application> {
    return this.applications.create(userId, token, dto);
  }

  @Patch(":id")
  @UseGuards(EntitlementGuard)
  @Requires("application_modify")
  update(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<Application> {
    return this.applications.update(userId, token, id, dto);
  }

  @Delete(":id")
  remove(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    return this.applications.remove(userId, token, id);
  }
}
