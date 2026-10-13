"use client";

import Link from "next/link";
import { useState } from "react";
import type { Application } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { InterviewPrepResponse, UpgradeRequiredPayload } from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PaywallModal } from "@/components/paywall-modal";
import { Skeleton } from "@/components/skeleton";

export function PrepClient() {
  const { data: applications, loading } = useApi<Application[]>(() =>
    api<Application[]>("/applications"),
  );

  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [result, setResult] = useState<InterviewPrepResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  // Only applications with a linked JD can be prepped — there is nothing to
  // predict questions from otherwise.
  const preppable = (applications ?? []).filter((a) => a.job_id && !a.archived);

  async function generate() {
    if (!applicationId) return;
    setGenerating(true);
    setError(null);
    try {
      setResult(
        await api<InterviewPrepResponse>(`/applications/${applicationId}/interview-prep`, {
          method: "POST",
        }),
      );
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setError(err instanceof Error ? err.message : "Interview prep failed");
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader />

      <Card>
        <CardHeader
          title="Choose an interview"
          description="Prep is built from the job description saved with the application."
        />
        <CardBody className="flex flex-col gap-3">
          {preppable.length === 0 ? (
            <EmptyState
              title="No applications with a job description yet"
              description="Prep needs the job description to predict questions. Link a job to an application in the Tracker, or run a Job Match — the job is saved automatically."
              action={
                <Link
                  href="/tracker"
                  className="inline-flex min-h-11 items-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-700"
                >
                  Go to Tracker
                </Link>
              }
            />
          ) : (
            <>
              <label htmlFor="prep-application" className="text-sm font-medium text-neutral-700">
                Application
              </label>
              <select
                id="prep-application"
                value={applicationId ?? ""}
                onChange={(e) => {
                  setApplicationId(e.target.value || null);
                  setResult(null);
                  setError(null);
                }}
                className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900"
              >
                <option value="">Select an application…</option>
                {preppable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.role} · {a.company}
                  </option>
                ))}
              </select>
              <Button
                onClick={generate}
                disabled={!applicationId}
                loading={generating}
                className="self-start"
              >
                Generate prep
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      {generating && (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Generating prep">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && !generating && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <p>{error}</p>
          <Button size="sm" variant="secondary" onClick={generate} disabled={!applicationId}>
            Try again
          </Button>
        </div>
      )}

      {result && !generating && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-neutral-900">
              Likely questions ({result.questions.length})
            </h2>
            {result.cached && <Badge tone="green">instant · cached</Badge>}
          </div>

          {result.questions.map((q, i) => (
            <Card key={i}>
              <CardHeader title={q.question} description={q.why} />
              <CardBody>
                <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                  Talking points from your CV
                </p>
                <ul className="mt-2 flex flex-col gap-2.5">
                  {q.talking_points.map((point, j) => (
                    <li key={j} className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-500"
                      />
                      <span className="text-sm text-neutral-700">{point}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}

          <Card>
            <CardHeader
              title="Questions to ask them"
              description="End the conversation well."
            />
            <CardBody>
              <ul className="flex flex-col gap-2.5">
                {result.questions_to_ask.map((q, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-500"
                    />
                    <span className="text-sm text-neutral-700">{q}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {result.gaps_flagged.length > 0 && (
            <div role="note" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-semibold">Gaps to prepare for</p>
              <p className="mt-0.5 text-amber-700">
                The job asks for these and your CV does not evidence them — prepare an honest
                answer rather than being caught out.
              </p>
              <ul className="mt-2 list-inside list-disc">
                {result.gaps_flagged.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Preparing for an interview"
      />
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Interview Prep</h1>
      <p className="mt-1 text-sm text-neutral-500">
        The questions this employer is likely to ask, with talking points from your actual CV.
      </p>
    </div>
  );
}
