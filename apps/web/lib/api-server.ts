import { request } from "./api-core";
import { createClient } from "./supabase/server";

/**
 * Server API client (server components / layouts). 401s throw ApiError —
 * redirects in server code are the caller's decision.
 */
export async function serverApi<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; json?: unknown } = {},
): Promise<T> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return request<T>(path, session?.access_token ?? null, options);
}
