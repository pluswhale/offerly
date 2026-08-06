import { Body, Controller, Get, Patch } from "@nestjs/common";
import type { Profile, SalaryExpectation, UpdateProfileRequest, UserGoals } from "@offerly/types";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { ProfilesService } from "./profiles.service.js";

class SalaryExpectationDto implements SalaryExpectation {
  @IsNumber()
  amount!: number;

  @IsString()
  currency!: string;

  @IsIn(["year", "month", "hour"])
  period!: "year" | "month" | "hour";
}

class UserGoalsDto implements Partial<UserGoals> {
  @IsOptional()
  @IsString()
  target_location?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SalaryExpectationDto)
  target_salary?: SalaryExpectation | null;

  @IsOptional()
  @IsString()
  priority?: string | null;
}

class UpdateProfileDto implements UpdateProfileRequest {
  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsString()
  current_role?: string;

  @IsOptional()
  @IsString()
  target_role?: string;

  @IsOptional()
  @IsString()
  experience_level?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  visa_status?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SalaryExpectationDto)
  salary_expectation?: SalaryExpectation;

  @IsOptional()
  @ValidateNested()
  @Type(() => UserGoalsDto)
  user_goals?: Partial<UserGoals>;

  @IsOptional()
  @IsBoolean()
  onboarding_completed?: boolean;
}

@Controller("profiles")
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get("me")
  getMe(@UserId() userId: string, @AccessToken() token: string): Promise<Profile> {
    return this.profiles.getMe(userId, token);
  }

  @Patch("me")
  updateMe(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<Profile> {
    return this.profiles.updateMe(userId, token, dto);
  }
}
