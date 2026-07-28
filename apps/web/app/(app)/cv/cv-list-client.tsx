"use client";

import Link from "next/link";
import type { Cv } from "@offerly/types";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { CvUploadForm } from "@/components/cv-upload-form";
import { EmptyState } from "@/components/empty-state";
import { SkeletonCard } from "@/components/skeleton";

export function CvListClient() {
  const { data: cvs, error, loading, refetch } = useApi<Cv[]>(() => api<Cv[]>("/cvs"));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">CV Analyzer</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Honest, specific feedback on your CV — with concrete fixes, not guesses.
        </p>
      </div>

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
              <Link href={`/cv/${cv.id}`} className="block rounded-xl focus-visible:outline-accent-600">
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardBody className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">
                        {cv.file_path ? cv.file_path.split("/").pop() : "Pasted text CV"}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Added {formatDate(cv.created_at)}
                      </p>
                    </div>
                    {cv.is_active && <Badge tone="accent">Active</Badge>}
                  </CardBody>
                </Card>
              </Link>
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
          <CvUploadForm onUploaded={() => refetch()} />
        </CardBody>
      </Card>
    </div>
  );
}
