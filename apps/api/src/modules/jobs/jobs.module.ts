import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { ApplyService } from "./apply.service.js";
import { JobAiController } from "./job-ai.controller.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { MatchService } from "./match.service.js";

@Module({
  imports: [AiModule, CvsModule, EntitlementsModule],
  controllers: [JobsController, JobAiController],
  providers: [JobsService, MatchService, ApplyService],
  exports: [JobsService],
})
export class JobsModule {}
