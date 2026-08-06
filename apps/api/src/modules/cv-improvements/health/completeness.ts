import type { CandidateProfile } from "@offerly/types";
import { computeSummaryQuality } from "../../ai/summary-quality.js";
import type { HealthItemDraft } from "./types.js";

/**
 * P0 — Profile completeness (spec 003 §FR-14). Surfaces the profile's
 * `summary_quality` (derived at pipeline persist time — read, not
 * recomputed; computeSummaryQuality is only the defensive fallback for rows
 * that predate it) and converts the top UNKNOWN fields into a concrete
 * to-do list. The checklist mirrors the summary-quality weighting so the
 * listed gaps are the ones that raise the score most.
 */

interface CompletenessCheck {
  path: string;
  label: string;
  covered: (profile: CandidateProfile) => boolean;
}

const stated = (leaf: { status: string }): boolean => leaf.status === "stated";

/** Ordered by summary-quality weight — the first gaps cost the most. */
const COMPLETENESS_CHECKS: readonly CompletenessCheck[] = [
  {
    path: "headline.title",
    label: "Current job title",
    covered: (p) => stated(p.headline.title),
  },
  {
    path: "headline.seniority",
    label: "Seniority level",
    covered: (p) => stated(p.headline.seniority),
  },
  {
    path: "headline.total_years_experience",
    label: "Total years of experience",
    covered: (p) => stated(p.headline.total_years_experience),
  },
  {
    path: "roles",
    label: "Work experience (roles with title and company)",
    covered: (p) => p.roles.some((role) => stated(role.title) && stated(role.company)),
  },
  {
    path: "skills.programming_languages",
    label: "Programming languages",
    covered: (p) => p.skills.programming_languages.length > 0,
  },
  {
    path: "skills.frameworks",
    label: "Frameworks",
    covered: (p) => p.skills.frameworks.length > 0,
  },
  {
    path: "skills.cloud_platforms",
    label: "Cloud platforms",
    covered: (p) => p.skills.cloud_platforms.length > 0,
  },
  {
    path: "skills.databases",
    label: "Databases",
    covered: (p) => p.skills.databases.length > 0,
  },
  {
    path: "skills.devops_tools",
    label: "DevOps tools",
    covered: (p) => p.skills.devops_tools.length > 0,
  },
  {
    path: "skills.other_technologies",
    label: "Other technologies",
    covered: (p) => p.skills.other_technologies.length > 0,
  },
  {
    path: "skills.soft_skills",
    label: "Soft skills",
    covered: (p) => p.skills.soft_skills.length > 0,
  },
  {
    path: "experience.industries",
    label: "Industries you've worked in",
    covered: (p) => p.experience.industries.length > 0,
  },
  {
    path: "experience.domains",
    label: "Business domains (e.g. fintech, B2B SaaS)",
    covered: (p) => p.experience.domains.length > 0,
  },
  {
    path: "experience.leadership",
    label: "Leadership or management experience",
    covered: (p) => stated(p.experience.leadership) || stated(p.experience.management),
  },
  {
    path: "education",
    label: "Education",
    covered: (p) => p.education.length > 0,
  },
  {
    path: "languages",
    label: "Languages you speak",
    covered: (p) => p.languages.length > 0,
  },
  {
    path: "location.current",
    label: "Current location",
    covered: (p) => stated(p.location.current),
  },
  {
    path: "certifications",
    label: "Certifications",
    covered: (p) => p.certifications.length > 0,
  },
];

/** At most this many to-dos — the highest-weighted gaps first. */
const MAX_TODOS = 5;

/** Below this score the item is a warning, otherwise informational. */
const WARNING_THRESHOLD = 70;

export function detectCompleteness(profile: CandidateProfile | null): HealthItemDraft {
  if (profile === null) {
    return {
      detector: "completeness",
      severity: "info",
      title: "No candidate profile yet",
      detail:
        "Run the candidate-profile pipeline for this CV to unlock profile " +
        "completeness tracking, keyword-gap analysis and duplicate-skill " +
        "detection.",
    };
  }

  const score = profile.summary_quality ?? computeSummaryQuality(profile);
  const gaps = COMPLETENESS_CHECKS.filter((check) => !check.covered(profile)).slice(0, MAX_TODOS);

  return {
    detector: "completeness",
    severity: score < WARNING_THRESHOLD && gaps.length > 0 ? "warning" : "info",
    title: `Profile completeness: ${score}/100`,
    detail:
      gaps.length > 0
        ? "Completing these fields raises the confidence of every job match. " +
          "Add them to your CV (or correct the profile directly): " +
          `${gaps.map((gap) => gap.label).join(", ")}.`
        : "Every key profile field is covered by your CV — match scores can be taken at face value.",
    ...(gaps.length > 0
      ? { examples: gaps.map((gap) => `${gap.path} — ${gap.label}`) }
      : {}),
  };
}
