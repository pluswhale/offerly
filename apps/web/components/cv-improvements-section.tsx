"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { CvImprovement } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import type {
  CvHealthRow,
  CvImprovementRow,
  CvImprovementSuggestion,
  HealthItem,
  HealthSeverity,
  ImprovementSuggestionStatus,
  UpgradeRequiredPayload,
} from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PaywallModal } from "@/components/paywall-modal";
import { Skeleton } from "@/components/skeleton";

/**
 * "Improve my CV" section (spec 003 §FR-12/§FR-13/§FR-14, T5.3–T5.5): three
 * tabs. Sentences/Bullets render per-suggestion ❌ original / ✅ improved
 * diffs with reason + category badge and accept/reject via PATCH. Health
 * renders the deterministic detector findings (severity, detail, evidence)
 * with per-item Dismiss. MVP does not auto-rewrite the CV file (spec §11) —
 * accepted items are the user's to-do list for their own editor.
 */

type RewriteType = "sentence" | "bullet";
type Tab = RewriteType | "health";

const TABS: ReadonlyArray<{ type: Tab; label: string }> = [
  { type: "sentence", label: "Sentences" },
  { type: "bullet", label: "Bullets" },
  { type: "health", label: "Health" },
];

const GENERATE_LABEL: Record<Tab, string> = {
  sentence: "Improve sentences",
  bullet: "Improve bullets",
  health: "Run health check",
};

const CATEGORY_LABELS: Record<string, string> = {
  vague_responsibility: "Vague responsibility",
  missing_action_verb: "Missing action verb",
  missing_outcome: "Missing outcome",
  first_person: "First-person voice",
  paragraph_should_be_bullets: "Should be bullets",
  filler_words: "Filler words",
  overlong_sentence: "Overlong sentence",
  weak_action_verb: "Weak action verb",
  missing_metric: "Missing metric",
  missing_impact: "Missing impact",
  vague_wording: "Vague wording",
};

function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known) return known;
  const fallback = category.replace(/_/g, " ");
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

const STATUS_ORDER: Record<ImprovementSuggestionStatus, number> = {
  pending: 0,
  accepted: 1,
  rejected: 2,
};

const SEVERITY_ORDER: Record<HealthSeverity, number> = { warning: 0, info: 1 };

function isRewriteRow(row: CvImprovement): row is CvImprovementRow {
  return row.type === "sentence" || row.type === "bullet";
}

function isHealthRow(row: CvImprovement): row is CvHealthRow {
  return row.type === "health";
}

/** Renders improved text with [bracketed placeholders] (spec §FR-13) highlighted. */
function PlaceholderText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\[[^\]]+\]$/.test(part) ? (
          <mark
            key={i}
            className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[0.85em] font-medium text-amber-900"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function CvImprovementsSection({ cvId }: { cvId: string }) {
  const [rows, setRows] = useState<CvImprovement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("sentence");
  const [generating, setGenerating] = useState<Tab | null>(null);
  const [patching, setPatching] = useState<string | null>(null); // suggestion id in flight
  const [actionError, setActionError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api<CvImprovement[]>(`/cvs/${cvId}/improvements`);
      setRows(all);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load improvements");
    }
  }, [cvId]);

  useEffect(() => {
    // Defer like useApi does: synchronous setState in an effect body causes
    // cascading renders (react-hooks/set-state-in-effect).
    queueMicrotask(() => void load());
  }, [load]);

  /** Latest row per type — the API returns rows newest first. */
  const latestFor = useCallback(
    (type: CvImprovement["type"]): CvImprovement | null =>
      rows?.find((row) => row.type === type) ?? null,
    [rows],
  );

  async function generate(type: Tab) {
    setGenerating(type);
    setActionError(null);
    try {
      const row = await api<CvImprovement>(`/cvs/${cvId}/improvements?type=${type}`, {
        method: "POST",
      });
      // Reused rows come back with their existing id — replace, don't duplicate.
      setRows((prev) => [row, ...(prev ?? []).filter((r) => r.id !== row.id)]);
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setActionError(err instanceof Error ? err.message : "Couldn't generate suggestions");
    } finally {
      setGenerating(null);
    }
  }

  async function setStatus(
    rowId: string,
    suggestionId: string,
    status: Exclude<ImprovementSuggestionStatus, "pending">,
  ) {
    setPatching(suggestionId);
    setActionError(null);
    try {
      const updated = await api<CvImprovement>(`/cvs/${cvId}/improvements/${rowId}`, {
        method: "PATCH",
        json: { suggestion_id: suggestionId, status },
      });
      setRows((prev) => (prev ?? []).map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't update the suggestion");
    } finally {
      setPatching(null);
    }
  }

  /** Accepted items across both rewrite types, as a plain-text markdown checklist. */
  function acceptedChecklist(): string {
    const lines: string[] = [];
    for (const type of ["sentence", "bullet"] as const) {
      const row = latestFor(type);
      if (!row || !isRewriteRow(row)) continue;
      for (const item of row.suggestions.items) {
        if (item.status !== "accepted") continue;
        lines.push(`- [ ] ${item.improved.replace(/\s+/g, " ").trim()}`);
      }
    }
    return lines.join("\n");
  }

  async function copyChecklist() {
    const text = acceptedChecklist();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError("Copy failed — select the text manually");
    }
  }

  const activeRow = latestFor(activeTab);
  const hasAccepted = acceptedChecklist().length > 0;

  return (
    <section aria-label="Improve my CV">
      <Card>
        <CardHeader
          title="Improve my CV"
          description="Concrete rewrites for weak sentences and bullets, plus deterministic health checks. Accept the ones you like — nothing changes your stored CV, the accepted list is yours to apply in your own editor."
          action={
            hasAccepted ? (
              <Button variant="secondary" size="sm" onClick={() => void copyChecklist()}>
                {copied ? "Copied ✓" : "Copy accepted as checklist"}
              </Button>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-4">
          {actionError && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {actionError}
            </p>
          )}

          <div role="tablist" aria-label="Improvement type" className="flex gap-1 self-start rounded-lg bg-neutral-100 p-1">
            {TABS.map(({ type, label }) => (
              <button
                key={type}
                role="tab"
                aria-selected={activeTab === type}
                onClick={() => setActiveTab(type)}
                className={`min-h-11 rounded-md px-4 text-sm font-medium transition-colors ${
                  activeTab === type
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-600 hover:text-neutral-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {rows === null && !loadError && (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading improvements">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {loadError && (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-sm text-red-700">
                {loadError}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          )}

          {generating !== null && (
            <div
              className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-3"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className="size-5 animate-spin rounded-full border-2 border-accent-600 border-t-transparent"
              />
              <p className="text-sm text-neutral-600">
                {generating === "health"
                  ? "Running health checks — just a moment…"
                  : "Reviewing your CV — this can take up to 30 seconds…"}
              </p>
            </div>
          )}

          {rows !== null && activeTab !== "health" && (
            <TypePanel
              type={activeTab}
              row={activeRow !== null && isRewriteRow(activeRow) ? activeRow : null}
              generating={generating !== null}
              patching={patching}
              onGenerate={() => void generate(activeTab)}
              onSetStatus={(suggestionId, status) => {
                if (activeRow) void setStatus(activeRow.id, suggestionId, status);
              }}
            />
          )}

          {rows !== null && activeTab === "health" && (
            <HealthPanel
              row={activeRow !== null && isHealthRow(activeRow) ? activeRow : null}
              generating={generating !== null}
              patching={patching}
              onRun={() => void generate("health")}
              onDismiss={(itemId) => {
                if (activeRow) void setStatus(activeRow.id, itemId, "rejected");
              }}
            />
          )}
        </CardBody>
      </Card>
      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Generating CV improvements"
      />
    </section>
  );
}

function TypePanel({
  type,
  row,
  generating,
  patching,
  onGenerate,
  onSetStatus,
}: {
  type: RewriteType;
  row: CvImprovementRow | null;
  generating: boolean;
  patching: string | null;
  onGenerate: () => void;
  onSetStatus: (
    suggestionId: string,
    status: Exclude<ImprovementSuggestionStatus, "pending">,
  ) => void;
}) {
  if (!row) {
    return (
      <EmptyState
        title={type === "sentence" ? "No sentence suggestions yet" : "No bullet suggestions yet"}
        description={
          type === "sentence"
            ? "Find weak or vague sentences in this CV and get concrete rewrites."
            : "Strengthen achievement bullets — stronger verbs, impact clauses, and metric placeholders you fill in."
        }
        action={
          <Button onClick={onGenerate} loading={generating}>
            {GENERATE_LABEL[type]}
          </Button>
        }
      />
    );
  }

  const { items, dropped_count, truncated } = row.suggestions;
  const sorted = [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const visible = sorted.filter((s) => s.status !== "rejected");
  const rejected = sorted.filter((s) => s.status === "rejected");

  return (
    <div className="flex flex-col gap-4">
      {truncated && (
        <p role="note" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your CV was longer than the input limit — suggestions cover the most important sections.
        </p>
      )}
      {dropped_count > 0 && (
        <p role="note" className="rounded-lg bg-neutral-50 px-4 py-2 text-sm text-neutral-600">
          {dropped_count === 1
            ? "1 suggestion couldn't be verified against your CV and was hidden."
            : `${dropped_count} suggestions couldn't be verified against your CV and were hidden.`}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No weak {type === "sentence" ? "sentences" : "bullets"} found — this CV looks good.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {visible.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              patching={patching === s.id}
              onSetStatus={(status) => onSetStatus(s.id, status)}
            />
          ))}
        </ul>
      )}

      {rejected.length > 0 && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm font-medium text-neutral-500 hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="inline-block transition-transform group-open:rotate-90"
            >
              ▸
            </span>
            Rejected ({rejected.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-4 opacity-70">
            {rejected.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                patching={patching === s.id}
                onSetStatus={(status) => onSetStatus(s.id, status)}
              />
            ))}
          </ul>
        </details>
      )}

      <div>
        <Button variant="secondary" size="sm" onClick={onGenerate} loading={generating}>
          Regenerate
        </Button>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  patching,
  onSetStatus,
}: {
  suggestion: CvImprovementSuggestion;
  patching: boolean;
  onSetStatus: (status: Exclude<ImprovementSuggestionStatus, "pending">) => void;
}) {
  const accepted = suggestion.status === "accepted";
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber">{categoryLabel(suggestion.category)}</Badge>
        {accepted && <Badge tone="green">Accepted ✓</Badge>}
        {suggestion.status === "rejected" && <Badge tone="neutral">Rejected</Badge>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg bg-red-50 p-3">
          <p className="text-xs font-semibold text-red-700">❌ Original</p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap text-neutral-800">
            {suggestion.original_span}
          </p>
        </div>
        <div className="min-w-0 rounded-lg bg-emerald-50 p-3">
          <p className="text-xs font-semibold text-emerald-700">✅ Improved</p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap text-neutral-800">
            <PlaceholderText text={suggestion.improved} />
          </p>
        </div>
      </div>

      <p className="text-sm text-neutral-600">{suggestion.reason}</p>

      <div className="flex flex-wrap gap-2">
        {suggestion.status !== "accepted" && (
          <Button size="sm" onClick={() => onSetStatus("accepted")} loading={patching}>
            Accept
          </Button>
        )}
        {suggestion.status !== "rejected" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSetStatus("rejected")}
            disabled={patching}
          >
            Reject
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Health tab (spec 003 §FR-14, T5.4/T5.5): deterministic detector findings.
 * Items are to-dos/questions — the only action is Dismiss (PATCH 'rejected',
 * same endpoint as the rewrite suggestions); dismissed items collapse into a
 * "Dismissed (n)" group. Re-running is free: no LLM call, no quota.
 */
function HealthPanel({
  row,
  generating,
  patching,
  onRun,
  onDismiss,
}: {
  row: CvHealthRow | null;
  generating: boolean;
  patching: string | null;
  onRun: () => void;
  onDismiss: (itemId: string) => void;
}) {
  if (!row) {
    return (
      <EmptyState
        title="No health check yet"
        description="Deterministic checks — profile completeness, missing keywords vs your matched jobs, duplicate skills, tense and date consistency, buzzwords, summary, and ATS format. Runs entirely in code: no AI cost."
        action={
          <Button onClick={onRun} loading={generating}>
            {GENERATE_LABEL.health}
          </Button>
        }
      />
    );
  }

  const { items } = row.suggestions;
  const visible = items
    .filter((item) => item.status !== "rejected")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const dismissed = items.filter((item) => item.status === "rejected");

  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 && (
        <p className="text-sm text-neutral-600">No issues found — this CV looks healthy.</p>
      )}
      {items.length > 0 && visible.length === 0 && (
        <p className="text-sm text-neutral-600">All findings dismissed — nothing left to act on.</p>
      )}

      {visible.length > 0 && (
        <ul className="flex flex-col gap-3">
          {visible.map((item) => (
            <HealthItemCard
              key={item.id}
              item={item}
              patching={patching === item.id}
              onDismiss={() => onDismiss(item.id)}
            />
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm font-medium text-neutral-500 hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="inline-block transition-transform group-open:rotate-90"
            >
              ▸
            </span>
            Dismissed ({dismissed.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-3 opacity-70">
            {dismissed.map((item) => (
              <HealthItemCard key={item.id} item={item} patching={false} />
            ))}
          </ul>
        </details>
      )}

      <div>
        <Button variant="secondary" size="sm" onClick={onRun} loading={generating}>
          Re-run health check
        </Button>
      </div>
    </div>
  );
}

function HealthItemCard({
  item,
  patching,
  onDismiss,
}: {
  item: HealthItem;
  patching: boolean;
  onDismiss?: () => void;
}) {
  const warning = item.severity === "warning";
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-0.5">
          {warning ? "⚠️" : "ℹ️"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-neutral-900">{item.title}</p>
            <Badge tone={warning ? "amber" : "blue"}>{warning ? "Warning" : "Info"}</Badge>
          </div>
          <p className="mt-1 text-sm break-words text-neutral-600">{item.detail}</p>
        </div>
      </div>

      {item.examples !== undefined && item.examples.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-neutral-200 pl-3">
          {item.examples.map((example, i) => (
            <li key={i} className="text-sm break-words text-neutral-600">
              “{example}”
            </li>
          ))}
        </ul>
      )}

      {onDismiss && (
        <div>
          <Button variant="secondary" size="sm" onClick={onDismiss} loading={patching}>
            Dismiss
          </Button>
        </div>
      )}
    </li>
  );
}
