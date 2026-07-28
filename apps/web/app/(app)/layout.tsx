import type { Profile } from "@offerly/types";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { serverApi } from "@/lib/api-server";
import { createClient } from "@/lib/supabase/server";

/**
 * Authenticated product shell. Guards: middleware handles the session;
 * this layout redirects to /onboarding until the profile is complete.
 * A failed profile fetch (API down) must never lock the user out.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let profile: Profile | null = null;
  try {
    profile = await serverApi<Profile>("/profiles/me");
  } catch {
    // API unreachable — render the shell; pages surface their own errors.
  }
  if (profile && !profile.onboarding_completed) redirect("/onboarding");

  return (
    <div className="flex min-h-screen">
      <AppNav userLabel={profile?.full_name ?? user.email ?? "Account"} />
      <main className="flex-1 px-4 pb-12 pt-20 md:px-8 md:pt-8">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
