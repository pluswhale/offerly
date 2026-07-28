"use client";

import Link from "next/link";
import { useState } from "react";
import type { Cv } from "@offerly/types";
import { api } from "@/lib/api";
import { cvDisplayName } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { Skeleton } from "./skeleton";

/**
 * Active-CV selector (T12.2). Switching PATCHes is_active on the chosen CV;
 * match/apply/coach keep resolving the active CV server-side, so the parent
 * just refetches its section data via onChanged. Zero CVs → upload prompt,
 * one CV → static label (no dropdown).
 */
export function CvSelector({ onChanged }: { onChanged?: () => void }) {
  const { data: cvs, loading, refetch } = useApi<Cv[]>(() => api<Cv[]>("/cvs"));
  const [switching, setSwitching] = useState(false);

  if (loading) {
    return <Skeleton className="h-11 w-full sm:max-w-xs" />;
  }

  if (!cvs || cvs.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        <Link href="/cv" className="font-medium text-accent-700 underline">
          Upload a CV first
        </Link>{" "}
        to use this section.
      </p>
    );
  }

  const active = cvs.find((c) => c.is_active) ?? cvs[0]!;

  if (cvs.length === 1) {
    return (
      <p className="text-sm text-neutral-600">
        CV: <span className="font-medium text-neutral-900">{cvDisplayName(active)}</span>
      </p>
    );
  }

  async function select(id: string) {
    if (id === active.id || switching) return;
    setSwitching(true);
    try {
      await api<Cv>(`/cvs/${id}`, { method: "PATCH", json: { is_active: true } });
      refetch();
      onChanged?.();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="cv-selector" className="text-sm font-medium text-neutral-700">
        Active CV
      </label>
      <select
        id="cv-selector"
        value={active.id}
        disabled={switching}
        onChange={(e) => select(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-accent-600 disabled:bg-neutral-50 sm:max-w-xs"
      >
        {cvs.map((cv) => (
          <option key={cv.id} value={cv.id}>
            {cvDisplayName(cv)}
            {cv.is_active ? " (active)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
