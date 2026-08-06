"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { Application, Cv, Job, Profile } from "@offerly/types";
import { api, ApiError, PaywallError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import {
  isMatchResultV2,
  type JobMatchAnyResult,
  type UpgradeRequiredPayload,
} from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { CvSelector } from "@/components/cv-selector";
import { EmptyState } from "@/components/empty-state";
import { GoalPrompt } from "@/components/goal-prompt";
import { Input } from "@/components/input";
import { MatchReportV2 } from "@/components/match-report-v2";
import { PaywallModal } from "@/components/paywall-modal";
import { ProgressiveProfilePrompt } from "@/components/progressive-profile-prompt";
import { ScoreRing } from "@/components/score-ring";
import { Skeleton } from "@/components/skeleton";
import { Textarea } from "@/components/textarea";

type Phase =
  | { kind: "form" }
  | { kind: "scoring" }
  | { kind: "result"; match: JobMatchAnyResult; job: Job; saved: boolean }
  /** 503 profile_pipeline_failed — the profile build died under the match. */
  | { kind: "pipeline_failed"; job: Job };

export function MatchClient() {
  const { data: cvs, loading: cvsLoading, refetch: refetchCvs } = useApi<Cv[]>(() =>
    api<Cv[]>("/cvs"),
  );
  const { data: profile, refetch: refetchProfile } = useApi<Profile>(() =>
    api<Profile>("/profiles/me"),
  );

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  const hasActiveCv = cvs?.some((c) => c.is_active) ?? false;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase({ kind: "scoring" });
    try {
      const job = await api<Job>("/jobs", {
        method: "POST",
        json: {
          title: title.trim(),
          company: company.trim() || undefined,
          url: url.trim() || undefined,
          description_text: description.trim(),
        },
      });
      await runMatch(job);
    } catch (err) {
      setPhase({ kind: "form" });
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setError(err instanceof Error ? err.message : "Match failed");
    }
  }

  /**
   * POST /jobs/:id/match. The first call can run the whole profile pipeline
   * inline (spec §FR-6), so the pending state doubles as the pipeline
   * progress indicator. A 503 profile_pipeline_failed gets a retry phase —
   * retrying is just POSTing again (the pipeline resumes from its failed
   * stage server-side).
   */
  async function runMatch(job: Job) {
    setError(null);
    setPhase({ kind: "scoring" });
    try {
      const match = await api<JobMatchAnyResult>(`/jobs/${job.id}/match`, {
        method: "POST",
      });
      setPhase({ kind: "result", match, job, saved: false });
    } catch (err) {
      if (err instanceof PaywallError) {
        setPhase({ kind: "form" });
        setPaywall(err.payload);
      } else if (err instanceof ApiError && err.status === 503) {
        setPhase({ kind: "pipeline_failed", job });
      } else {
        setPhase({ kind: "form" });
        setError(err instanceof Error ? err.message : "Match failed");
      }
    }
  }

  async function saveToTracker(job: Job) {
    try {
      await api<Application>("/applications", {
        method: "POST",
        json: {
          job_id: job.id,
          company: job.company ?? (company.trim() || "Unknown company"),
          role: job.title,
          status: "saved",
        },
      });
      setPhase((p) => (p.kind === "result" ? { ...p, saved: true } : p));
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setError(err instanceof Error ? err.message : "Could not save to tracker");
    }
  }

  if (cvsLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Progressive profiling hook (T6.2): match needs a CV first.
  if (!hasActiveCv) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader />
        <EmptyState
          title="Upload your CV first"
          description="Job Match compares a job description against your CV. Add your CV and you'll get a score in seconds."
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

      {/* Switching CV invalidates the shown result — it was scored against the old one. */}
      <CvSelector
        onChanged={() => {
          refetchCvs();
          setPhase({ kind: "form" });
        }}
      />

      <Card>
        <CardBody>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Job title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Senior Frontend Engineer"
                required
              />
              <Input
                label="Company (optional)"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme Inc."
              />
            </div>
            <Input
              label="Job URL (optional)"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
            <Textarea
              label="Job description"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Paste the full job description…"
              hint="The fuller the description, the more confident the score."
              required
            />
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <Button
              type="submit"
              loading={phase.kind === "scoring"}
              disabled={description.trim().length < 50 || !title.trim()}
              className="self-start"
            >
              {phase.kind === "scoring" ? "Analyzing…" : "Score this job"}
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* T4.4: one missing user_goals field, asked inline — never blocking. */}
      <GoalPrompt profile={profile} onSaved={() => refetchProfile()} />

      {phase.kind === "scoring" && (
        <Card>
          <CardBody className="flex items-center gap-3" aria-live="polite">
            <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-accent-600 border-t-transparent" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-neutral-800">Analyzing profile &amp; matching…</p>
              <p className="text-sm text-neutral-600">
                The first match builds your candidate profile along the way — this can take up to a minute.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {phase.kind === "pipeline_failed" && (
        <Card>
          <CardBody className="flex flex-col items-start gap-3" aria-live="polite">
            <p role="alert" className="text-sm text-red-700">
              We couldn&apos;t build your profile, so the match couldn&apos;t run.
              Retrying picks up where it left off.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void runMatch(phase.job)}>
              Retry
            </Button>
          </CardBody>
        </Card>
      )}

      {phase.kind === "result" && (
        <MatchResult
          match={phase.match}
          jobId={phase.job.id}
          saved={phase.saved}
          onSave={() => saveToTracker(phase.job)}
          onRematch={() => runMatch(phase.job)}
        />
      )}

      {phase.kind === "result" && (
        <ProgressiveProfilePrompt
          profile={profile}
          field="location"
          reason="Some jobs weigh location and visa fit — this sharpens future matches."
        />
      )}

      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Scoring this job match"
      />
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Job Match</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Paste a job description to see how your CV stacks up — before you spend time applying.
      </p>
    </div>
  );
}

function MatchResult({
  match,
  jobId,
  saved,
  onSave,
  onRematch,
}: {
  match: JobMatchAnyResult;
  jobId: string;
  saved: boolean;
  onSave: () => void;
  onRematch: () => Promise<void>;
}) {
  // v2 reports (result.version === 2) get the explainable report; legacy v1
  // rows keep the strengths/gaps/recommendations rendering (spec §11: old
  // rows stay readable).
  if (isMatchResultV2(match)) {
    return (
      <>
        <ScoreHeader
          score={match.score}
          lowConfidence={match.result.low_confidence}
          lowConfidenceText="Too many must-haves are unanswered — complete your profile below to trust this number."
          confidenceText="Computed from your candidate profile against this job's structured requirements."
          saved={saved}
          onSave={onSave}
          jobId={jobId}
        />
        <MatchReportV2 match={match} onRematch={onRematch} />
      </>
    );
  }

  const { result } = match;
  return (
    <>
      <ScoreHeader
        score={match.score}
        lowConfidence={result.low_confidence}
        lowConfidenceText={
          result.confidence_note ??
          "This job description is short or vague — treat the score as a rough signal, not a verdict."
        }
        confidenceText="Based on your active CV versus this job description."
        saved={saved}
        onSave={onSave}
        jobId={jobId}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <ResultList title="Strengths" items={result.strengths} tone="green" />
        <ResultList title="Gaps" items={result.gaps} tone="red" />
        <ResultList title="Recommendations" items={result.recommendations} tone="accent" />
      </div>
    </>
  );
}

function ScoreHeader({
  score,
  lowConfidence,
  lowConfidenceText,
  confidenceText,
  saved,
  onSave,
  jobId,
}: {
  score: number;
  lowConfidence: boolean;
  lowConfidenceText: string;
  confidenceText: string;
  saved: boolean;
  onSave: () => void;
  jobId: string;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-4 sm:flex-row sm:gap-8">
        <ScoreRing score={score} size={112} label="match" />
        <div className="flex flex-col gap-2 text-center sm:text-left">
          {lowConfidence ? (
            <Badge tone="amber">Low confidence</Badge>
          ) : (
            <Badge tone={score >= 70 ? "green" : score >= 40 ? "amber" : "red"}>
              {score >= 70 ? "Strong match" : score >= 40 ? "Partial match" : "Weak match"}
            </Badge>
          )}
          <p className="max-w-md text-sm text-neutral-600">
            {lowConfidence ? lowConfidenceText : confidenceText}
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2 sm:justify-start">
            {saved ? (
              <Badge tone="green">Saved to tracker</Badge>
            ) : (
              <Button size="sm" onClick={onSave}>
                Save to tracker
              </Button>
            )}
            <Link
              href={`/apply?jobId=${jobId}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
            >
              Generate application →
            </Link>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ResultList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "green" | "red" | "accent";
}) {
  const dot =
    tone === "green" ? "bg-emerald-500" : tone === "red" ? "bg-red-500" : "bg-accent-500";
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">None identified.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {items.map((item, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
                <span className="text-sm text-neutral-700">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
