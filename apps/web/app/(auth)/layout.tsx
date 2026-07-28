import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-2xl font-bold tracking-tight text-neutral-900">
        Offerly
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
