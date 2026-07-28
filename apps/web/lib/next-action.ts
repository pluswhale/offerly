import type { Application, Cv } from "@offerly/types";

export interface NextAction {
  title: string;
  description: string;
  href: string;
  cta: string;
}

const FOLLOW_UP_DAYS = 7;

/**
 * Client-side rule engine for the dashboard "next best action" card
 * (spec §5.1, tasks T3.3/T8.3). Pure function of fetched data — works even
 * when AI quota is exhausted (constitution §V graceful degradation).
 */
export function nextBestAction(input: {
  cvs: Cv[];
  applications: Application[];
}): NextAction {
  const { cvs, applications } = input;
  const active = applications.filter((a) => !a.archived);

  // 1. No CV → upload is the unlock for everything else.
  if (!cvs.some((c) => c.is_active)) {
    return {
      title: "Upload your CV",
      description:
        "Your CV powers analysis, job match scores, and tailored applications. It takes under a minute.",
      href: "/cv",
      cta: "Upload CV",
    };
  }

  // 2. CV but no tracked jobs → get a first match score.
  if (active.length === 0) {
    return {
      title: "Score your first job match",
      description:
        "Paste a job description to see how your CV stacks up — then save it to your tracker.",
      href: "/match",
      cta: "Run a Job Match",
    };
  }

  // 3. Everything rejected → improve inputs instead of waiting.
  if (active.every((a) => a.status === "rejected")) {
    return {
      title: "Strengthen your CV",
      description:
        "Your applications so far were rejected. A sharper CV and better-targeted matches will move the needle.",
      href: "/cv",
      cta: "Improve my CV",
    };
  }

  // 4. Stale applications → follow up.
  const cutoff = Date.now() - FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
  const stale = active.filter(
    (a) =>
      a.status === "applied" &&
      (a.applied_at ?? a.created_at) < new Date(cutoff).toISOString(),
  );
  if (stale.length > 0) {
    return {
      title: `Follow up on ${stale.length} application${stale.length === 1 ? "" : "s"}`,
      description: `Applied more than ${FOLLOW_UP_DAYS} days ago with no reply. A short follow-up keeps you on the radar.`,
      href: "/tracker",
      cta: "Open tracker",
    };
  }

  // 5. Default: keep the pipeline moving.
  return {
    title: "Keep the momentum",
    description:
      "Add today's jobs to the tracker and score them against your CV before applying.",
    href: "/match",
    cta: "Score a job",
  };
}
