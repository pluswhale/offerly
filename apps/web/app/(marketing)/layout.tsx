import Link from "next/link";
import type { ReactNode } from "react";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-neutral-100">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4">
          <Link href="/" className="text-xl font-bold tracking-tight text-neutral-900">
            Offerly
          </Link>
          <nav className="flex items-center gap-2" aria-label="Marketing">
            <Link
              href="/pricing"
              className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-neutral-600 hover:text-neutral-900"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-neutral-600 hover:text-neutral-900"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="flex min-h-11 items-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-700"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-neutral-100 py-8">
        <p className="text-center text-sm text-neutral-400">
          © {new Date().getFullYear()} Offerly — land your next offer faster.
        </p>
      </footer>
    </div>
  );
}
