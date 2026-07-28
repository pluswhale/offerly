"use client";

import Link from "next/link";
import { useState } from "react";
import type { Cv } from "@offerly/types";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { cvDisplayName, formatDate } from "@/lib/format";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { CvSelector } from "@/components/cv-selector";
import { CvUploadForm } from "@/components/cv-upload-form";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/input";
import { Modal } from "@/components/modal";
import { SkeletonCard } from "@/components/skeleton";

export function CvListClient() {
  const { data: cvs, error, loading, refetch } = useApi<Cv[]>(() => api<Cv[]>("/cvs"));

  // The CV a free user would swap out when hitting the 1-CV limit (T12.3).
  const replaceCv = cvs?.find((c) => c.is_active) ?? cvs?.[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">CV Analyzer</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Honest, specific feedback on your CV — with concrete fixes, not guesses.
        </p>
      </div>

      <CvSelector onChanged={refetch} />

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading CVs">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : error || !cvs ? (
        <EmptyState
          title="Couldn't load your CVs"
          description={error ?? undefined}
          action={<Button onClick={refetch}>Try again</Button>}
        />
      ) : cvs.length === 0 ? (
        <EmptyState
          title="No CV yet"
          description="Upload your CV to get a score, section-by-section feedback, and a prioritized fix list."
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {cvs.map((cv) => (
            <li key={cv.id}>
              <CvCard cv={cv} onChanged={refetch} />
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader
          title={cvs && cvs.length > 0 ? "Upload a new version" : "Add your CV"}
          description="Re-uploading an unchanged CV is free — results are cached per content."
        />
        <CardBody>
          <CvUploadForm onUploaded={() => refetch()} replaceCv={replaceCv} />
        </CardBody>
      </Card>
    </div>
  );
}

/** One CV card (T12.3): link to detail + rename / set active / delete. */
function CvCard({ cv, onChanged }: { cv: Cv; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(cvDisplayName(cv));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === cvDisplayName(cv)) {
      setRenaming(false);
      setName(cvDisplayName(cv));
      return;
    }
    await run(async () => {
      await api<Cv>(`/cvs/${cv.id}`, { method: "PATCH", json: { name: trimmed } });
      setRenaming(false);
    });
  }

  return (
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="CV name"
                  value={name}
                  maxLength={120}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <Button size="sm" loading={busy} onClick={() => void saveName()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Link
                href={`/cv/${cv.id}`}
                className="block truncate rounded text-sm font-medium text-neutral-900 hover:text-accent-700 focus-visible:outline-accent-600"
              >
                {cvDisplayName(cv)}
              </Link>
            )}
            <p className="mt-0.5 text-xs text-neutral-500">Added {formatDate(cv.created_at)}</p>
          </div>
          {cv.is_active && <Badge tone="accent">Active</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </Button>
          {!cv.is_active && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() =>
                void run(() =>
                  api<Cv>(`/cvs/${cv.id}`, { method: "PATCH", json: { is_active: true } }),
                )
              }
            >
              Set active
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>

        {actionError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}

        <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete CV?">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-700">
              <span className="font-medium">{cvDisplayName(cv)}</span> and its analyses and
              job matches will be permanently deleted.
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/cvs/${cv.id}`, { method: "DELETE" });
                    setConfirmDelete(false);
                  })
                }
              >
                Delete
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      </CardBody>
    </Card>
  );
}
