import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CvImprovementsController } from "./cv-improvements.controller.js";
import { CvImprovementsService } from "./cv-improvements.service.js";

@Module({
  imports: [AiModule, CvsModule, EntitlementsModule],
  controllers: [CvImprovementsController],
  providers: [CvImprovementsService],
})
export class CvImprovementsModule {}
