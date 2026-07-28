import type { Metadata } from "next";
import { Suspense } from "react";
import { ApplyClient } from "./apply-client";

export const metadata: Metadata = { title: "Apply Assistant — Offerly" };

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const { jobId } = await searchParams;
  return (
    <Suspense>
      <ApplyClient initialJobId={jobId ?? null} />
    </Suspense>
  );
}
