"use client";

import Link from "next/link";
import { useState } from "react";
import type { Cv } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { CvAnalysisWithResult, UpgradeRequiredPayload } from "@/lib/contract";
import { cvDisplayName, formatDate } from "@/lib/format";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PaywallModal } from "@/components/paywall-modal";
import { ScoreRing } from "@/components/score-ring";
import { Skeleton, SkeletonCard } from "@/components/skeleton";

interface DetailData {
  cv: Cv | null;
  analyses: CvAnalysisWithResult[];
}

export function CvDetailClient({ cvId }: { cvId: string }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  const { data, error, loading, refetch } = useApi<DetailData>(
    async () => {
      const [cvs, analyses] = await Promise.all([
        api<Cv[]>("/cvs"),
        api<CvAnalysisWithResult[]>(`/cvs/${cvId}/analyses`),
      ]);
      return { cv: cvs.find((c) => c.id === cvId) ?? null, analyses };
    },
    [cvId],
  );

  async function runAnalysis() {
    setAnalyzing(true);
    setActionError(null);
    try {
      await api<CvAnalysisWithResult>(`/cvs/${cvId}/analyze`, { method: "POST" });
      refetch();
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setActionError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading analysis">
        <Skeleton className="h-8 w-40" />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        title="Couldn't load this CV"
        description={error ?? undefined}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  const { cv, analyses } = data;
  const latest = analyses[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/cv" className="text-sm text-neutral-500 hover:text-neutral-700">
            ← All CVs
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-neutral-900">
            {cv ? cvDisplayName(cv) : "CV"}
          </h1>
        </div>
        <Button onClick={runAnalysis} loading={analyzing}>
          {latest ? "Re-analyze" : "Analyze my CV"}
        </Button>
      </div>

      {analyzing && (
        <Card>
          <CardBody className="flex items-center gap-3" aria-live="polite">
            <span className="size-5 animate-spin rounded-full border-2 border-accent-600 border-t-transparent" aria-hidden="true" />
            <p className="text-sm text-neutral-600">
              Analyzing your CV — this can take up to 30 seconds…
            </p>
          </CardBody>
        </Card>
      )}

      {actionError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {!latest && !analyzing ? (
        <EmptyState
          title="No analysis yet"
          description="Run your first analysis to get a score, section feedback, and a prioritized fix list."
        />
      ) : latest ? (
        <>
          {/* Score + meta */}
          <Card>
            <CardBody className="flex flex-col items-center gap-4 sm:flex-row sm:gap-8">
              <ScoreRing score={latest.score} size={112} label="overall" />
              <div className="flex flex-col gap-2 text-center sm:text-left">
                <div className="flex items-center justify-center gap-2 sm:justify-start">
                  <Badge tone="accent">{latest.depth} analysis</Badge>
                  <span className="text-xs text-neutral-500">
                    {formatDate(latest.created_at)}
                  </span>
                </div>
                <p className="max-w-md text-sm text-neutral-600">
                  {latest.score >= 70
                    ? "Strong CV. Polish the remaining items below to stand out."
                    : latest.score >= 40
                      ? "Solid foundation — the improvements below are ordered by impact."
                      : "This CV needs work, but every fix below is concrete and doable."}
                </p>
              </div>
            </CardBody>
          </Card>

          {latest.result.truncated && (
            <p role="note" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {latest.result.truncated_note ??
                "Your CV was longer than the analysis limit — the most important sections were analyzed."}
            </p>
          )}
          {latest.result.language_warning && (
            <p role="note" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {latest.result.language_warning}
            </p>
          )}

          {/* Section feedback */}
          <Card>
            <CardHeader title="Section feedback" description="What the score is based on." />
            <CardBody>
              <ul className="flex flex-col gap-4">
                {latest.result.sections.map((s) => (
                  <li key={s.name} className="flex items-start gap-4">
                    <ScoreRing score={s.score} size={56} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-neutral-900">{s.name}</p>
                      <p className="mt-0.5 text-sm text-neutral-600">{s.feedback}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Improvements checklist */}
          <Card>
            <CardHeader
              title="Prioritized improvements"
              description="Fix these in order — #1 moves the needle most."
            />
            <CardBody>
              <ol className="flex flex-col gap-3">
                {latest.result.improvements.map((imp) => (
                  <li key={imp.priority} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-600 text-xs font-bold text-white"
                    >
                      {imp.priority}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-neutral-900">{imp.title}</p>
                      <p className="mt-0.5 text-sm text-neutral-600">{imp.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </>
      ) : null}

      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Analyzing another CV"
      />
    </div>
  );
}
