import { Module } from "@nestjs/common";
import { EntitlementGuard } from "./entitlement.guard.js";
import { EntitlementsService } from "./entitlements.service.js";

@Module({
  providers: [EntitlementsService, EntitlementGuard],
  exports: [EntitlementsService, EntitlementGuard],
})
export class EntitlementsModule {}
