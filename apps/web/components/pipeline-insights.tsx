import type { Application } from "@offerly/types";
import { Card, CardBody, CardHeader } from "@/components/card";
import { StatusBadge } from "@/components/status-badge";
import {
  OPEN_STAGES,
  QUIET_DAYS,
  daysInStage,
  type PipelineInsights as Insights,
} from "@/lib/pipeline-insights";

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function days(value: number | null): string {
  if (value === null) return "—";
  const n = Math.round(value);
  return `${n} day${n === 1 ? "" : "s"}`;
}

export function PipelineInsights({
  insights,
  now,
  onSelect,
}: {
  insights: Insights;
  now: Date;
  onSelect: (app: Application) => void;
}) {
  const tiles = [
    { label: "Applied", value: String(insights.applied) },
    { label: "Reply rate", value: percent(insights.replyRate) },
    { label: "Interview rate", value: percent(insights.interviewRate) },
  ];

  return (
    <Card>
      <CardHeader title="Is your search working?" />
      <CardBody className="flex flex-col gap-5">
        <dl className="grid gap-3 md:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg bg-neutral-50 px-4 py-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {t.label}
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums text-neutral-900">{t.value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-5 md:grid-cols-2">
          <section aria-labelledby="stage-age-heading">
            <h3 id="stage-age-heading" className="text-sm font-semibold text-neutral-900">
              Average time in current stage
            </h3>
            <ul className="mt-2 flex flex-col gap-2">
              {OPEN_STAGES.map((stage) => (
                <li key={stage} className="flex items-center justify-between gap-3">
                  <StatusBadge status={stage} />
                  <span className="text-sm tabular-nums text-neutral-700">
                    {days(insights.avgDaysInStage[stage])}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="quiet-heading">
            <h3 id="quiet-heading" className="text-sm font-semibold text-neutral-900">
              Gone quiet ({insights.quiet.length})
            </h3>
            {insights.quiet.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-500">
                Nothing has stalled — every application moved in the last {QUIET_DAYS} days.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-neutral-100">
                {insights.quiet.map((app) => (
                  <li key={app.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(app)}
                      className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 py-2 text-left"
                    >
                      <span className="min-w-0 truncate text-sm font-medium text-neutral-900">
                        {app.role} · {app.company}
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        quiet {days(daysInStage(app, now))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <p className="text-xs text-neutral-500">
          Based on each application&apos;s current status, excluding archived ones. Rejections
          count as applied, whatever stage they were rejected at.
        </p>
      </CardBody>
    </Card>
  );
}
