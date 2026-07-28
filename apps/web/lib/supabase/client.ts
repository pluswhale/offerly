"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client. Env fallbacks are placeholders so `next build`
 * can prerender without real credentials; real values come from
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY at runtime.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key",
  );
}
