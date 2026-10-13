import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CvsModule } from "../cvs/cvs.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { PrepController } from "./prep.controller.js";
import { PrepService } from "./prep.service.js";

@Module({
  imports: [AiModule, CvsModule, JobsModule, EntitlementsModule],
  controllers: [PrepController],
  providers: [PrepService],
})
export class PrepModule {}
