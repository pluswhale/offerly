import type { CandidateProfile, ProfileSkills } from "@offerly/types";
import { normalizeForMatch } from "../../ai/text.js";
import { canonicalizeSkill } from "../../ai/matching/aliases.js";
import type { HealthItemDraft } from "./types.js";

/**
 * P1 — Duplicate skills (spec 003 §FR-14). Alias-folds every stated profile
 * skill ("JS" → "javascript") and flags canonical forms listed more than
 * once, within or across skill groups. The suggestion is always to keep one
 * canonical form — never to auto-remove anything.
 */

const SKILL_GROUPS = [
  "programming_languages",
  "frameworks",
  "cloud_platforms",
  "databases",
  "devops_tools",
  "other_technologies",
  "soft_skills",
] as const satisfies readonly (keyof ProfileSkills)[];

/** At most this many duplicate groups per run. */
const MAX_EXAMPLES = 5;

export function detectDuplicateSkills(profile: CandidateProfile): HealthItemDraft | null {
  // canonical → normalized variant → display form as written in the profile.
  const byCanonical = new Map<string, Map<string, string>>();
  for (const group of SKILL_GROUPS) {
    for (const skill of profile.skills[group]) {
      if (skill.status !== "stated" || skill.value === null) continue;
      const canonical = canonicalizeSkill(skill.value);
      const variant = normalizeForMatch(skill.value);
      const variants = byCanonical.get(canonical) ?? new Map<string, string>();
      if (!variants.has(variant)) variants.set(variant, skill.value);
      byCanonical.set(canonical, variants);
    }
  }

  const duplicates = [...byCanonical.entries()].filter(([, variants]) => variants.size > 1);
  if (duplicates.length === 0) return null;

  const examples = duplicates.slice(0, MAX_EXAMPLES).map(([canonical, variants]) => {
    const displays = [...variants.values()];
    // Prefer the variant that literally is the canonical form ("JavaScript"
    // over "JS"); otherwise the longest — usually the most formal spelling.
    const keep =
      variants.get(canonical) ?? displays.reduce((a, b) => (b.length > a.length ? b : a));
    return `${displays.map((d) => `"${d}"`).join(" and ")} — keep "${keep}"`;
  });

  return {
    detector: "duplicate_skills",
    severity: "warning",
    title:
      duplicates.length === 1
        ? "One skill is listed under two different names"
        : `${duplicates.length} skills are listed under different names`,
    detail:
      "These entries are the same skill spelled differently (aliases are " +
      "folded, so e.g. \"JS\" and \"JavaScript\" count as one). Listing both " +
      "reads as padding to recruiters — keep a single canonical form.",
    examples,
  };
}
