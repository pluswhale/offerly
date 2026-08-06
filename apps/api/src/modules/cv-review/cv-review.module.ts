import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CandidateProfilesModule } from "../candidate-profiles/candidate-profiles.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CvReviewController } from "./cv-review.controller.js";
import { CvReviewService } from "./cv-review.service.js";

@Module({
  imports: [AiModule, CvsModule, CandidateProfilesModule, EntitlementsModule],
  controllers: [CvReviewController],
  providers: [CvReviewService],
})
export class CvReviewModule {}
