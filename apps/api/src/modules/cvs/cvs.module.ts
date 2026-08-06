import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { CvsController } from "./cvs.controller.js";
import { CvsService } from "./cvs.service.js";

@Module({
  imports: [EntitlementsModule],
  controllers: [CvsController],
  providers: [CvsService],
  exports: [CvsService],
})
export class CvsModule {}
