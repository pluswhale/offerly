import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CandidateProfilesController } from "./candidate-profiles.controller.js";
import { ProfilePipelineService } from "./profile-pipeline.service.js";

@Module({
  imports: [AiModule, CvsModule, EntitlementsModule],
  controllers: [CandidateProfilesController],
  providers: [ProfilePipelineService],
  exports: [ProfilePipelineService],
})
export class CandidateProfilesModule {}
