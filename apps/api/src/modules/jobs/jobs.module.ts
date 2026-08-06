import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CandidateProfilesModule } from "../candidate-profiles/candidate-profiles.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { ApplyService } from "./apply.service.js";
import { JobAiController } from "./job-ai.controller.js";
import { JobProfileService } from "./job-profile.service.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { MatchService } from "./match.service.js";

@Module({
  imports: [AiModule, CvsModule, CandidateProfilesModule, EntitlementsModule],
  controllers: [JobsController, JobAiController],
  providers: [JobsService, MatchService, ApplyService, JobProfileService],
  exports: [JobsService, JobProfileService],
})
export class JobsModule {}
