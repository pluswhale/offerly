import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CoachController } from "./coach.controller.js";
import { CoachService } from "./coach.service.js";

@Module({
  imports: [AiModule, EntitlementsModule],
  controllers: [CoachController],
  providers: [CoachService],
})
export class CoachModule {}
