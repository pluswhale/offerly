import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "../../common/authenticated-request.js";
import { EntitlementsService } from "./entitlements.service.js";
import { PaymentRequiredException } from "./payment-required.exception.js";
import { REQUIRES_FEATURE_KEY, type GatedFeature } from "./requires.decorator.js";

/**
 * Enforces @Requires(feature) server-side on every request (T10.2).
 * Applied per-endpoint via @UseGuards(EntitlementGuard); runs after the
 * global AuthGuard, so userId/token are already on the request.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<GatedFeature>(
      REQUIRES_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const params = req.params as Record<string, string | undefined>;
    const denial = await this.entitlements.checkAccess(req.userId, req.accessToken, feature, {
      cvId: feature === "cv_analysis" ? params.id : undefined,
      jobId: feature === "job_match" || feature === "apply_generate" ? params.id : undefined,
      body: req.body as unknown,
    });
    if (denial) {
      throw new PaymentRequiredException(denial.feature, denial.reason);
    }
    return true;
  }
}
