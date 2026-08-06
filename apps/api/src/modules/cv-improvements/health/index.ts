import type { CandidateProfile, ProfileSkills } from "@offerly/types";
import { canonicalizeSkill } from "../../ai/matching/aliases.js";
import { detectAtsFormat } from "./ats-format.js";
import { detectBuzzwords } from "./buzzwords.js";
import { detectCompleteness } from "./completeness.js";
import { detectDateFormats } from "./date-formats.js";
import { detectDuplicateSkills } from "./duplicate-skills.js";
import { detectMissingKeywords } from "./missing-keywords.js";
import { detectQuantifiedAchievements } from "./quantified-achievements.js";
import { detectTechAdjacency } from "./tech-adjacency.js";
import { detectTenseConsistency } from "./tense-consistency.js";
import { detectWeakSummary } from "./weak-summary.js";
import type { HealthItemDraft, HealthMatchReport } from "./types.js";

/**
 * CV Health orchestration (spec 003 §FR-14, T5.4/T5.5): runs every
 * deterministic detector over the profile + CV text + existing match
 * reports. Pure code — zero LLM calls, zero token cost; the stored row
 * carries template_version 'health.v2' so a detector change (T5.5 added
 * three) invalidates reuse cleanly and old rows regenerate.
 */
export const HEALTH_TEMPLATE_VERSION = "health.v2";

export interface HealthInput {
  cvText: string;
  /** Latest ready CandidateProfile for the CV, or null when not built yet. */
  profile: CandidateProfile | null;
  /** Recent v2 match reports, newest first (duplicates by jobId allowed). */
  matchReports: HealthMatchReport[];
}

const SKILL_GROUPS = [
  "programming_languages",
  "frameworks",
  "cloud_platforms",
  "databases",
  "devops_tools",
  "other_technologies",
  "soft_skills",
] as const satisfies readonly (keyof ProfileSkills)[];

/** Alias-folded canonical forms of every stated profile skill. */
export function canonicalSkillSet(profile: CandidateProfile | null): Set<string> {
  const skills = new Set<string>();
  if (profile === null) return skills;
  for (const group of SKILL_GROUPS) {
    for (const skill of profile.skills[group]) {
      if (skill.status === "stated" && skill.value !== null) {
        skills.add(canonicalizeSkill(skill.value));
      }
    }
  }
  return skills;
}

/** Run all detectors; every draft becomes one stored health item. */
export function runHealthDetectors(input: HealthInput): HealthItemDraft[] {
  const items: HealthItemDraft[] = [];
  const skills = canonicalSkillSet(input.profile);

  items.push(detectCompleteness(input.profile));
  items.push(...detectMissingKeywords(input.matchReports, skills, input.cvText));
  if (input.profile !== null) {
    const duplicates = detectDuplicateSkills(input.profile);
    if (duplicates !== null) items.push(duplicates);
  }
  const tense = detectTenseConsistency(input.cvText);
  if (tense !== null) items.push(tense);
  const dates = detectDateFormats(input.cvText);
  if (dates !== null) items.push(dates);
  const buzzwords = detectBuzzwords(input.cvText);
  if (buzzwords !== null) items.push(buzzwords);
  const quantified = detectQuantifiedAchievements(input.cvText);
  if (quantified !== null) items.push(quantified);
  // T5.5 — P2 detectors.
  items.push(...detectWeakSummary(input.cvText));
  items.push(...detectTechAdjacency(skills));
  items.push(...detectAtsFormat(input.cvText));

  return items;
}

export type { HealthItem, HealthItemDraft, HealthMatchReport } from "./types.js";
