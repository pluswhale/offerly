import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { PLAN_LIMITS, type Cv, type CvAnalysis } from "@offerly/types";
import {
  IsBoolean,
  IsInt,
  IsMimeType,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { EntitlementGuard } from "../entitlements/entitlement.guard.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { Requires } from "../entitlements/requires.decorator.js";
import { CvsService, type SignedUpload } from "./cvs.service.js";

class CreateCvDto {
  /** Paste flow: raw CV text. */
  @IsOptional()
  @IsString()
  @MinLength(50)
  @MaxLength(100_000)
  text?: string;

  /** Upload flow: file metadata for the signed URL. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @IsOptional()
  @IsMimeType()
  content_type?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  size_bytes?: number;

  /** Free-tier replace flow (T12.1): delete this owned CV before creating. */
  @IsOptional()
  @IsUUID()
  replace_cv_id?: string;
}

class ConfirmCvDto {
  @IsUUID()
  cv_id!: string;
}

class UpdateCvDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

@Controller("cvs")
export class CvsController {
  constructor(
    private readonly cvs: CvsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post()
  @UseGuards(EntitlementGuard)
  @Requires("cv_create")
  async create(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: CreateCvDto,
  ): Promise<Cv | SignedUpload> {
    // Replace flow: swap the old CV out first so the free 1-CV limit holds.
    if (dto.replace_cv_id) await this.cvs.remove(userId, token, dto.replace_cv_id);
    if (dto.text) {
      return this.cvs.createFromText(userId, token, dto.text);
    }
    if (dto.filename && dto.content_type && dto.size_bytes !== undefined) {
      return this.cvs.createSignedUpload(userId, token, {
        filename: dto.filename,
        contentType: dto.content_type,
        sizeBytes: dto.size_bytes,
      });
    }
    throw new UnprocessableEntityException(
      "Provide either `text` (paste) or filename + content_type + size_bytes (upload)",
    );
  }

  @Post("confirm")
  confirm(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: ConfirmCvDto,
  ): Promise<Cv> {
    return this.cvs.confirmUpload(userId, token, dto.cv_id);
  }

  @Get()
  list(@UserId() userId: string, @AccessToken() token: string): Promise<Cv[]> {
    return this.cvs.list(userId, token);
  }

  @Patch(":id")
  update(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateCvDto,
  ): Promise<Cv> {
    return this.cvs.update(userId, token, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.cvs.remove(userId, token, id);
  }

  @Post(":id/analyze")
  @UseGuards(EntitlementGuard)
  @Requires("cv_analysis")
  async analyze(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CvAnalysis> {
    const plan = await this.entitlements.getPlan(userId, token);
    return this.cvs.analyze(userId, token, id, PLAN_LIMITS[plan].matchDepth);
  }

  @Get(":id/analyses")
  listAnalyses(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CvAnalysis[]> {
    return this.cvs.listAnalyses(userId, token, id);
  }
}
