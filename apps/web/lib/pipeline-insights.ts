import type { Application, ApplicationStatus } from "@offerly/types";

export const QUIET_DAYS = 14;

export const OPEN_STAGES = ["saved", "applied", "interview"] as const;

export type OpenStage = (typeof OPEN_STAGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const QUIET_STATUSES: ApplicationStatus[] = ["applied", "interview"];

export interface PipelineInsights {
  applied: number;
  replyRate: number | null;
  interviewRate: number | null;
  avgDaysInStage: Record<OpenStage, number | null>;
  quiet: Application[];
}

export function isQuiet(app: Application, now: Date): boolean {
  const cutoff = now.getTime() - QUIET_DAYS * DAY_MS;
  return (
    !app.archived &&
    QUIET_STATUSES.includes(app.status) &&
    new Date(app.status_changed_at).getTime() < cutoff
  );
}

export function daysInStage(app: Application, now: Date): number {
  const ms = now.getTime() - new Date(app.status_changed_at).getTime();
  return Math.max(0, Math.floor(ms / DAY_MS));
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

export function derivePipelineInsights(
  applications: Application[],
  now: Date,
): PipelineInsights {
  const active = applications.filter((a) => !a.archived);
  const count = (...statuses: ApplicationStatus[]) =>
    active.filter((a) => statuses.includes(a.status)).length;

  const applied = count("applied", "interview", "offer", "rejected");

  const avgDaysInStage = Object.fromEntries(
    OPEN_STAGES.map((stage) => {
      const days = active.filter((a) => a.status === stage).map((a) => daysInStage(a, now));
      const avg = days.length === 0 ? null : days.reduce((s, d) => s + d, 0) / days.length;
      return [stage, avg];
    }),
  ) as Record<OpenStage, number | null>;

  return {
    applied,
    replyRate: rate(count("interview", "offer", "rejected"), applied),
    interviewRate: rate(count("interview", "offer"), applied),
    avgDaysInStage,
    quiet: active
      .filter((a) => isQuiet(a, now))
      .sort(
        (a, b) =>
          new Date(a.status_changed_at).getTime() - new Date(b.status_changed_at).getTime(),
      ),
  };
}
