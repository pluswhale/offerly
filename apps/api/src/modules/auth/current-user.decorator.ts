import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "../../common/authenticated-request.js";

/** Injects the authenticated user's id (attached by AuthGuard). */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().userId,
);

/** Injects the bearer token (needed to build the RLS-scoped Supabase client). */
export const AccessToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().accessToken,
);
