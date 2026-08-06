"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { RequirementVerdict, ScoreComponent, VerdictValue } from "@offerly/types";
import { api, ApiError } from "@/lib/api";
import type { JobMatchWithResultV2, MatchRequirementSnapshot } from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";

/**
 * Match report v2 (spec 003 §FR-7/§FR-8, T3.5): explainable score header with
 * the weighted breakdown, per-requirement verdicts with expandable evidence,
 * and honest-degradation banners (vague JD, >40% unknown must-haves). Unknown
 * must-haves are surfaced as "Not in your CV" items that lead to the profile
 * page — inline PATCH only when a verdict cites a string-array profile path.
 */

const COMPONENT_ORDER: readonly ScoreComponent[] = [
  "must_have",
  "nice_to_have",
  "experience",
  "industry",
  "location_remote",
  "languages",
  "education",
];

const COMPONENT_LABELS: Record<ScoreComponent, string> = {
  must_have: "Must-have requirements",
  nice_to_have: "Nice-to-have requirements",
  experience: "Experience",
  industry: "Industry & domain",
  location_remote: "Location & remote",
  languages: "Languages",
  education: "Education & certifications",
};

/** Stacked-bar segment colors, in COMPONENT_ORDER. */
const COMPONENT_COLORS: Record<ScoreComponent, string> = {
  must_have: "bg-accent-600",
  nice_to_have: "bg-accent-300",
  experience: "bg-emerald-500",
  industry: "bg-sky-500",
  location_remote: "bg-amber-400",
  languages: "bg-neutral-500",
  education: "bg-neutral-300",
};

const VERDICT_META: Record<
  VerdictValue,
  { label: string; tone: "green" | "amber" | "neutral" | "red" }
> = {
  match: { label: "Match", tone: "green" },
  partial: { label: "Partial", tone: "amber" },
  unknown: { label: "Unknown", tone: "neutral" },
  missing: { label: "Missing", tone: "red" },
};

const IMPORTANCE_LABELS: Record<MatchRequirementSnapshot["importance"], string> = {
  must_have: "Must-have",
  nice_to_have: "Nice-to-have",
};

/**
 * candidate_evidence entries look like `path: "quote"` (spec §FR-7). Split the
 * verifier-style profile path from the quote; entries without one render raw.
 */
function parseEvidenceEntry(entry: string): { path: string | null; text: string } {
  const idx = entry.indexOf(":");
  if (idx > 0) {
    const candidate = entry.slice(0, idx);
    if (/^[A-Za-z_]\w*(?:\.\w+|\[\d+\])*$/.test(candidate)) {
      return {
        path: candidate,
        text: entry.slice(idx + 1).trim().replace(/^"|"$/g, ""),
      };
    }
  }
  return { path: null, text: entry };
}

/**
 * A profile path is only PATCH-able inline when it targets a string-array
 * leaf (skills.*, industries/domains, work_authorization) — those resolve to
 * existing string Evidenced leaves, so a text answer fits the schema. Scalar
 * and numeric leaves are edited on the profile page instead.
 */
function answerablePath(verdict: RequirementVerdict): string | null {
  for (const entry of verdict.candidate_evidence) {
    const { path } = parseEvidenceEntry(entry);
    if (
      path &&
      (path.startsWith("skills.") ||
        path.startsWith("experience.industries[") ||
        path.startsWith("experience.domains[") ||
        path.startsWith("location.work_authorization["))
    ) {
      return path;
    }
  }
  return null;
}

export function MatchReportV2({
  match,
  onRematch,
}: {
  match: JobMatchWithResultV2;
  /** Re-run POST /jobs/:id/match after a profile correction. */
  onRematch: () => Promise<void>;
}) {
  const { result } = match;
  const requirementById = new Map(result.requirements.map((r) => [r.id, r]));
  const unknownMustHaves = result.verdicts.filter(
    (v) =>
      v.verdict === "unknown" &&
      requirementById.get(v.requirement_id)?.importance === "must_have",
  );

  return (
    <>
      {result.low_confidence && (
        <div
          role="status"
          className="flex flex-col items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm font-medium text-amber-900">
            Complete your profile to improve this score
          </p>
          <p className="text-sm text-amber-800">
            {Math.round(result.unknown_must_have_share * 100)}% of this job&apos;s
            must-have requirements aren&apos;t covered by your profile yet — the
            score is a lower bound, not a verdict. Answer the items below and
            re-match.
          </p>
          <Link
            href={`/cv/${match.cv_id}`}
            className="inline-flex min-h-11 items-center rounded-lg bg-amber-600 px-4 text-sm font-medium text-white hover:bg-amber-700"
          >
            Complete your profile
          </Link>
        </div>
      )}

      {result.jd_low_confidence && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm text-amber-800">
            {result.warning ??
              "This job description is short/vague — treat the score as a rough estimate."}
          </p>
        </div>
      )}

      <ScoreBreakdownCard match={match} />

      {unknownMustHaves.length > 0 && (
        <NotInYourCvCard
          verdicts={unknownMustHaves}
          requirementById={requirementById}
          cvId={match.cv_id}
          onRematch={onRematch}
        />
      )}

      <RequirementsCard verdicts={result.verdicts} requirementById={requirementById} />
    </>
  );
}

/* ---------- Weighted breakdown (spec §FR-8) ---------- */

function ScoreBreakdownCard({ match }: { match: JobMatchWithResultV2 }) {
  const { breakdown, score } = match.result;
  return (
    <Card>
      <CardHeader
        title="How this score is built"
        description={`Weights ${match.result.weights_version} — each component contributes its share of the total.`}
      />
      <CardBody className="flex flex-col gap-4">
        {/* Stacked bar: segment widths are exact contributions — the stack
            literally sums to the total score. */}
        <div
          className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-100"
          role="img"
          aria-label={`Score ${score} out of 100, composed of the weighted components below`}
        >
          {COMPONENT_ORDER.map((key) => (
            <span
              key={key}
              className={COMPONENT_COLORS[key]}
              style={{ width: `${breakdown[key].contribution * 100}%` }}
            />
          ))}
        </div>

        <ul className="flex flex-col gap-3">
          {COMPONENT_ORDER.map((key) => {
            const component = breakdown[key];
            const points = component.contribution * 100;
            return (
              <li key={key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm text-neutral-700">
                    {COMPONENT_LABELS[key]}
                    <span className="ml-2 text-xs text-neutral-400">
                      weight {Math.round(component.weight * 100)}%
                    </span>
                  </p>
                  <p className="text-sm font-medium tabular-nums text-neutral-900">
                    {points.toFixed(1)} pts
                  </p>
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
                  role="img"
                  aria-label={`${COMPONENT_LABELS[key]}: ${Math.round(component.component_score * 100)}% of its weight`}
                >
                  <div
                    className={`h-full rounded-full ${COMPONENT_COLORS[key]}`}
                    style={{ width: `${component.component_score * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex items-baseline justify-between border-t border-neutral-100 pt-3">
          <p className="text-sm font-semibold text-neutral-900">Total</p>
          <p className="text-sm font-bold tabular-nums text-neutral-900">{score} / 100</p>
        </div>
      </CardBody>
    </Card>
  );
}

/* ---------- Unknown must-haves → clarifying answers (spec §FR-7, AC-7) ---------- */

function NotInYourCvCard({
  verdicts,
  requirementById,
  cvId,
  onRematch,
}: {
  verdicts: RequirementVerdict[];
  requirementById: Map<string, MatchRequirementSnapshot>;
  cvId: string;
  onRematch: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader
        title="Not in your CV"
        description="Your profile doesn't mention these must-haves — answer them to make this score trustworthy."
      />
      <CardBody className="flex flex-col gap-4">
        <ul className="flex flex-col gap-4">
          {verdicts.map((verdict) => {
            const requirement = requirementById.get(verdict.requirement_id);
            const path = answerablePath(verdict);
            return (
              <li
                key={verdict.requirement_id}
                className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3"
              >
                <p className="text-sm font-medium text-neutral-900">
                  {requirement?.text ?? verdict.requirement_id}
                </p>
                {verdict.reasoning && (
                  <p className="text-sm text-neutral-600">{verdict.reasoning}</p>
                )}
                {path ? (
                  <InlineAnswer cvId={cvId} path={path} onSaved={onRematch} />
                ) : (
                  <Link
                    href={`/cv/${cvId}`}
                    className="inline-flex min-h-11 items-center self-start rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                  >
                    Answer in your profile →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Inline clarifying answer (T3.5): only offered when the verdict cites a
 * string-array profile path — everything else links to the profile page.
 * Saving PATCHes the profile (T2.5) and re-runs the match so the new score
 * reflects the answer.
 */
function InlineAnswer({
  cvId,
  path,
  onSaved,
}: {
  cvId: string;
  path: string;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/cvs/${cvId}/profile`, {
        method: "PATCH",
        json: { path, value: value.trim() },
      });
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? "Couldn't save this here — answer it on your profile page instead."
          : err instanceof Error
            ? err.message
            : "Couldn't save your answer",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your answer, e.g. a skill you use"
          aria-label={`Answer for ${path}`}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-accent-500 focus:ring-2 focus:ring-accent-100 focus:outline-none"
        />
        <Button type="submit" size="sm" loading={saving} disabled={!value.trim()}>
          Save &amp; re-match
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

/* ---------- Per-requirement verdicts (spec §FR-7) ---------- */

function RequirementsCard({
  verdicts,
  requirementById,
}: {
  verdicts: RequirementVerdict[];
  requirementById: Map<string, MatchRequirementSnapshot>;
}) {
  return (
    <Card>
      <CardHeader
        title="Requirements"
        description="Every requirement from the job description, matched against your profile."
      />
      <CardBody>
        {verdicts.length === 0 ? (
          <p className="text-sm text-neutral-500">
            This job description states no concrete requirements to check.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {verdicts.map((verdict) => (
              <VerdictRow
                key={verdict.requirement_id}
                verdict={verdict}
                requirement={requirementById.get(verdict.requirement_id)}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function VerdictRow({
  verdict,
  requirement,
}: {
  verdict: RequirementVerdict;
  requirement: MatchRequirementSnapshot | undefined;
}) {
  const meta = VERDICT_META[verdict.verdict];
  const evidence = verdict.candidate_evidence.map(parseEvidenceEntry);
  return (
    <li>
      <details className="group py-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-1 hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="min-w-0 flex-1 text-sm text-neutral-800">
            {requirement?.text ?? verdict.requirement_id}
          </span>
          {requirement && (
            <span className="hidden shrink-0 gap-1 sm:inline-flex">
              <Badge tone={requirement.importance === "must_have" ? "accent" : "neutral"}>
                {IMPORTANCE_LABELS[requirement.importance]}
              </Badge>
            </span>
          )}
          <span
            aria-hidden="true"
            className="shrink-0 text-neutral-400 transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </summary>
        <div className="flex flex-col gap-2 px-1 pt-1 pb-3">
          {requirement && (
            <p className="text-xs text-neutral-500">
              {IMPORTANCE_LABELS[requirement.importance]} · {requirement.category}
            </p>
          )}
          {verdict.reasoning && (
            <p className="text-sm text-neutral-700">{verdict.reasoning}</p>
          )}
          {evidence.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {evidence.map((item, i) => (
                <li
                  key={i}
                  className="rounded-lg border-l-2 border-accent-200 bg-neutral-50 px-3 py-2"
                >
                  <p className="text-sm text-neutral-700 italic">“{item.text}”</p>
                  {item.path && (
                    <p className="mt-0.5 font-mono text-xs text-neutral-400">{item.path}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {evidence.length === 0 && verdict.verdict === "unknown" && (
            <p className="text-sm text-neutral-500">
              Your profile is silent on this — the system isn&apos;t claiming you
              lack it.
            </p>
          )}
        </div>
      </details>
    </li>
  );
}
