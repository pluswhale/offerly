import type { Application, ApplicationStatus } from "@offerly/types";

export const STALE_DAYS = 14;

const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const MAX_LISTED_STALE = 3;

const REACHED_APPLIED: ApplicationStatus[] = ["applied", "interview", "offer", "rejected"];
const REACHED_INTERVIEW: ApplicationStatus[] = ["interview", "offer"];
const REACHED_OFFER: ApplicationStatus[] = ["offer"];
const REPLIED: ApplicationStatus[] = ["interview", "offer", "rejected"];
const AWAITING_REPLY: ApplicationStatus[] = ["saved", "applied"];

export interface FunnelStage {
  key: "saved" | "applied" | "interview" | "offer";
  label: string;
  count: number;
  /** Conversion from the previous stage, 0–1. null when the previous stage is 0. */
  conversionFromPrevious: number | null;
}

export interface PipelineInsights {
  /** Non-archived total; 0 means the caller should not render the panel. */
  total: number;
  /** Share of applied-or-beyond that got any reply (interview, offer or rejected). null when nothing was applied. */
  replyRate: number | null;
  /** Share of applied-or-beyond that reached interview or offer. null when nothing was applied. */
  interviewRate: number | null;
  staleCount: number;
  /** Up to 3, oldest updated_at first. */
  staleApplications: Application[];
  funnel: FunnelStage[];
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export function derivePipelineInsights(
  applications: Application[],
  now: Date,
): PipelineInsights {
  const active = applications.filter((a) => !a.archived);
  const countOf = (statuses: ApplicationStatus[]) =>
    active.filter((a) => statuses.includes(a.status)).length;

  const total = active.length;
  const reachedApplied = countOf(REACHED_APPLIED);
  const reachedInterview = countOf(REACHED_INTERVIEW);
  const reachedOffer = countOf(REACHED_OFFER);
  const replied = countOf(REPLIED);

  const stale = active
    .filter(
      (a) =>
        AWAITING_REPLY.includes(a.status) &&
        now.getTime() - new Date(a.updated_at).getTime() > STALE_MS,
    )
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());

  const funnel: FunnelStage[] = [
    { key: "saved", label: "Saved", count: total, conversionFromPrevious: null },
    {
      key: "applied",
      label: "Applied",
      count: reachedApplied,
      conversionFromPrevious: ratio(reachedApplied, total),
    },
    {
      key: "interview",
      label: "Interview",
      count: reachedInterview,
      conversionFromPrevious: ratio(reachedInterview, reachedApplied),
    },
    {
      key: "offer",
      label: "Offer",
      count: reachedOffer,
      conversionFromPrevious: ratio(reachedOffer, reachedInterview),
    },
  ];

  return {
    total,
    replyRate: ratio(replied, reachedApplied),
    interviewRate: ratio(reachedInterview, reachedApplied),
    staleCount: stale.length,
    staleApplications: stale.slice(0, MAX_LISTED_STALE),
    funnel,
  };
}
