"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/cv", label: "CV" },
  { href: "/match", label: "Match" },
  { href: "/apply", label: "Apply" },
  { href: "/tracker", label: "Tracker" },
  { href: "/coach", label: "Coach" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ userLabel }: { userLabel: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const linkClass = (href: string) =>
    `flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-accent-50 text-accent-700"
        : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
    }`;

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-neutral-200 bg-white px-3 py-5 md:flex">
        <Link href="/dashboard" className="mb-6 px-3 text-xl font-bold tracking-tight text-neutral-900">
          Offerly
        </Link>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={linkClass(item.href)}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-neutral-100 pt-3">
          <p className="truncate px-3 text-sm text-neutral-500">{userLabel}</p>
          <button
            type="button"
            onClick={signOut}
            className="mt-1 flex min-h-11 w-full cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile header + collapsible nav */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-neutral-200 bg-white md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-neutral-900">
            Offerly
          </Link>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg text-neutral-700 hover:bg-neutral-100"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {menuOpen ? (
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <nav aria-label="Main" className="flex flex-col gap-1 border-t border-neutral-100 bg-white px-3 py-3">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className={linkClass(item.href)}
              >
                {item.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={signOut}
              className="flex min-h-11 items-center rounded-lg px-3 text-left text-sm font-medium text-neutral-600 hover:bg-neutral-100"
            >
              Sign out ({userLabel})
            </button>
          </nav>
        )}
      </header>
    </>
  );
}
