"use client";

import { request } from "./api-core";
import { createClient } from "./supabase/client";

export { ApiError, PaywallError } from "./api-core";

/**
 * Browser API client (T2.3): attaches the Supabase access token, redirects
 * to /login on 401, throws PaywallError with the structured payload on 402.
 */
export async function api<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; json?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return request<T>(path, session?.access_token ?? null, options, () => {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${next}`;
  });
}
