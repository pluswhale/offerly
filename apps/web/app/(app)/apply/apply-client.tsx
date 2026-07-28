"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Application, Cv } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { ApplyGeneration, UpgradeRequiredPayload } from "@/lib/contract";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/input";
import { PaywallModal } from "@/components/paywall-modal";
import { Skeleton } from "@/components/skeleton";
import { Textarea } from "@/components/textarea";

export function ApplyClient({ initialJobId }: { initialJobId: string | null }) {
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const { data: cvs, loading: cvsLoading } = useApi<Cv[]>(() => api<Cv[]>("/cvs"));
  const { data: applications, loading: appsLoading } = useApi<Application[]>(() =>
    api<Application[]>("/applications"),
  );

  const [generation, setGeneration] = useState<ApplyGeneration | null>(null);
  const [coverLetter, setCoverLetter] = useState("");
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  // Elapsed-time feedback: never a frozen spinner for >10s (spec §5.4).
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [generating]);

  const hasActiveCv = cvs?.some((c) => c.is_active) ?? false;
  const trackedJobs = (applications ?? []).filter((a) => a.job_id && !a.archived);

  async function generate(regenInstruction?: string) {
    if (!jobId) return;
    setElapsed(0);
    setGenerating(true);
    setError(null);
    try {
      const result = await api<ApplyGeneration>(`/jobs/${jobId}/apply`, {
        method: "POST",
        json: regenInstruction ? { instruction: regenInstruction } : {},
      });
      setGeneration(result);
      setCoverLetter(result.cover_letter);
      setAnswers(result.answers);
      setInstruction("");
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setError("Copy failed — select the text manually");
    }
  }

  if (cvsLoading || appsLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!hasActiveCv) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader />
        <EmptyState
          title="Upload your CV first"
          description="The Apply Assistant grounds every letter and answer in your actual CV — it never invents experience."
          action={
            <Link
              href="/cv"
              className="inline-flex min-h-11 items-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-700"
            >
              Upload CV
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader />

      {/* Job picker */}
      <Card>
        <CardHeader
          title="Choose a job"
          description="Pick a tracked job, or score a new one first."
        />
        <CardBody className="flex flex-col gap-3">
          {trackedJobs.length === 0 ? (
            <EmptyState
              title="No tracked jobs yet"
              description="Run a Job Match first — the job is saved automatically and appears here."
              action={
                <Link
                  href="/match"
                  className="inline-flex min-h-11 items-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-700"
                >
                  Run a Job Match
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="apply-job" className="text-sm font-medium text-neutral-700">
                Job
              </label>
              <select
                id="apply-job"
                value={jobId ?? ""}
                onChange={(e) => {
                  setJobId(e.target.value || null);
                  setGeneration(null);
                }}
                className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900"
              >
                <option value="">Select a job…</option>
                {trackedJobs.map((a) => (
                  <option key={a.id} value={a.job_id ?? ""}>
                    {a.role} · {a.company}
                  </option>
                ))}
              </select>
              <Button
                onClick={() => generate()}
                disabled={!jobId}
                loading={generating}
                className="self-start"
              >
                Generate application
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {generating && (
        <Card>
          <CardBody className="flex items-center gap-3" aria-live="polite">
            <span className="size-5 animate-spin rounded-full border-2 border-accent-600 border-t-transparent" aria-hidden="true" />
            <p className="text-sm text-neutral-600">
              {elapsed < 10
                ? "Writing your tailored application…"
                : `Still working (${elapsed}s) — long cover letters take a little longer. Hang tight.`}
            </p>
          </CardBody>
        </Card>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {generation && !generating && (
        <>
          {generation.sample && (
            <div
              role="note"
              className="rounded-lg border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-900"
            >
              <span className="font-semibold">Free sample preview.</span> This is a
              watermarked sample generation.{" "}
              <Link href="/pricing" className="font-medium underline">
                Upgrade to Pro
              </Link>{" "}
              for full, unlimited applications.
            </div>
          )}

          {generation.gaps_flagged.length > 0 && (
            <div role="note" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-semibold">Honest gap flags</p>
              <ul className="mt-1 list-inside list-disc">
                {generation.gaps_flagged.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Cover letter */}
          <div className="relative">
            {generation.sample && <Watermark />}
            <Card>
              <CardHeader
                title="Cover letter"
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => copy(coverLetter, "letter")}
                  >
                    {copied === "letter" ? "Copied ✓" : "Copy"}
                  </Button>
                }
              />
              <CardBody>
                <Textarea
                  label="Cover letter (editable)"
                  rows={14}
                  value={coverLetter}
                  onChange={(e) => setCoverLetter(e.target.value)}
                />
              </CardBody>
            </Card>
          </div>

          {/* Answers */}
          {answers.length > 0 && (
            <Card>
              <CardHeader title="Application answers" />
              <CardBody className="flex flex-col gap-5">
                {answers.map((a, i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold text-neutral-900">{a.question}</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copy(a.answer, `answer-${i}`)}
                      >
                        {copied === `answer-${i}` ? "Copied ✓" : "Copy"}
                      </Button>
                    </div>
                    <Textarea
                      label={`Answer ${i + 1} (editable)`}
                      rows={5}
                      value={a.answer}
                      onChange={(e) =>
                        setAnswers((prev) =>
                          prev.map((p, j) =>
                            j === i ? { ...p, answer: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {/* Recommendations */}
          {generation.recommendations.length > 0 && (
            <Card>
              <CardHeader title="What to emphasize" />
              <CardBody>
                <ul className="flex flex-col gap-2.5">
                  {generation.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-500" />
                      <span className="text-sm text-neutral-700">{r}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {/* Regeneration */}
          <Card>
            <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  label="Regenerate with an instruction"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder='e.g. "shorter", "more formal", "emphasize leadership"'
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => generate(instruction.trim() || undefined)}
                loading={generating}
                disabled={!jobId}
              >
                Regenerate
              </Button>
            </CardBody>
          </Card>
        </>
      )}

      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Generating a tailored application"
      />
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Apply Assistant</h1>
      <p className="mt-1 text-sm text-neutral-500">
        A tailored cover letter and application answers, grounded in your actual CV.
      </p>
    </div>
  );
}

function Watermark() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <span className="rotate-[-18deg] text-4xl font-bold text-neutral-300/60 select-none">
        SAMPLE
      </span>
    </div>
  );
}
