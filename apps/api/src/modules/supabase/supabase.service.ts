import { Injectable } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "../../common/env.js";

/**
 * Supabase access (plan §5):
 * - `forUser(token)` — per-request client carrying the user's JWT, so RLS
 *   applies. Used for everything user-initiated.
 * - `getServiceClient()` — service-role, bypasses RLS. Webhooks, usage
 *   metering and llm_cache only. Never exposed to controllers handling
 *   user data directly.
 */
@Injectable()
export class SupabaseService {
  private readonly url = requireEnv("SUPABASE_URL");
  private readonly anonKey = requireEnv("SUPABASE_ANON_KEY");
  private readonly anonClient: SupabaseClient;
  private readonly serviceClient: SupabaseClient;

  constructor() {
    const auth = { persistSession: false, autoRefreshToken: false };
    this.anonClient = createClient(this.url, this.anonKey, { auth });
    this.serviceClient = createClient(
      this.url,
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth },
    );
  }

  /** Anon client — used by AuthGuard for `auth.getUser(token)`. */
  getAnonClient(): SupabaseClient {
    return this.anonClient;
  }

  /** Service-role client — bypasses RLS. Webhooks + metering + llm_cache only. */
  getServiceClient(): SupabaseClient {
    return this.serviceClient;
  }

  /** Per-request client scoped to the user's JWT (RLS enforced). */
  forUser(accessToken: string): SupabaseClient {
    return createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }
}
