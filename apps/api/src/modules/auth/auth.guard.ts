import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "../../common/authenticated-request.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

/**
 * Global auth guard (T2.2): validates the Supabase JWT via
 * `auth.getUser(token)` on every request except @Public() routes
 * (/health, /api/v1/billing/webhooks/*). Attaches userId + token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const { data, error } = await this.supabase.getAnonClient().auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException("Invalid or expired token");
    }

    req.userId = data.user.id;
    req.accessToken = token;
    return true;
  }
}
