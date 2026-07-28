import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { ApplicationsController } from "./applications.controller.js";
import { ApplicationsService } from "./applications.service.js";

@Module({
  imports: [EntitlementsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
