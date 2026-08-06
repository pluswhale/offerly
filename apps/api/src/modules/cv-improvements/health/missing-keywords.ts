import { normalizeForMatch } from "../../ai/text.js";
import { canonicalizePhrase, TECH_ALIASES } from "../../ai/matching/aliases.js";
import { containsPhrase } from "../../ai/matching/prepass.js";
import type { HealthItemDraft, HealthMatchReport } from "./types.js";

/**
 * P0 — Missing keywords vs matched jobs (spec 003 §FR-14). Reuses the user's
 * existing v2 match reports (zero LLM cost): must-have requirements with
 * verdict 'missing' or 'unknown' name skills the jobs demand; any such skill
 * that never appears in the candidate's profile skills or CV text (both
 * alias-folded) becomes one to-do item. Phrased as a question/to-do — the
 * detector never adds anything to the CV or profile.
 */

/** Reports beyond this count are ignored — recent matches matter most. */
const MAX_REPORTS = 10;

/** At most this many keyword items per health run. */
const MAX_ITEMS = 5;

/** Same tech-aware boundaries as the matching pre-pass. */
const WORD_CHAR = /[\p{L}\p{N}+#./-]/u;

/**
 * The skill mention as written in the requirement text (keeps the original
 * casing — "Docker", not the canonical "docker"). Falls back to null when
 * the mention cannot be located; callers then use the canonical form.
 */
function findMention(rawText: string, alias: string): string | null {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<!${WORD_CHAR.source})${escaped}(?!${WORD_CHAR.source})`, "iu");
  return re.exec(rawText)?.[0] ?? null;
}

interface SkillGap {
  display: string;
  jobIds: Set<string>;
}

/** Canonical tech skills mentioned in a requirement text, with display form. */
function mentionedSkills(requirementText: string): Map<string, string> {
  const normalized = normalizeForMatch(requirementText);
  const found = new Map<string, string>();
  for (const [alias, canonical] of Object.entries(TECH_ALIASES)) {
    if (found.has(canonical)) continue;
    if (containsPhrase(normalized, alias)) {
      found.set(canonical, findMention(requirementText, alias) ?? canonical);
    }
  }
  return found;
}

export function detectMissingKeywords(
  reports: readonly HealthMatchReport[],
  candidateCanonicalSkills: ReadonlySet<string>,
  cvText: string,
): HealthItemDraft[] {
  if (reports.length === 0) {
    return [
      {
        detector: "missing_keywords",
        severity: "info",
        title: "No match reports yet",
        detail:
          "Match a few jobs to unlock keyword-gap analysis — this check is " +
          "free and reuses your existing match reports to find must-have " +
          "skills your CV never mentions.",
      },
    ];
  }

  // Latest report per job wins; reports arrive newest-first from the service.
  const seenJobs = new Set<string>();
  const gaps = new Map<string, SkillGap>();
  let considered = 0;
  const cvCanonical = canonicalizePhrase(cvText);

  for (const report of reports) {
    if (considered >= MAX_REPORTS) break;
    if (seenJobs.has(report.jobId)) continue;
    seenJobs.add(report.jobId);
    considered += 1;

    const verdictByReq = new Map(report.verdicts.map((v) => [v.requirement_id, v.verdict]));
    const countedHere = new Set<string>();
    for (const req of report.requirements) {
      if (req.importance !== "must_have") continue;
      const verdict = verdictByReq.get(req.id);
      if (verdict !== "missing" && verdict !== "unknown") continue;
      for (const [canonical, display] of mentionedSkills(req.text)) {
        if (candidateCanonicalSkills.has(canonical)) continue;
        if (containsPhrase(cvCanonical, canonical)) continue;
        if (countedHere.has(canonical)) continue;
        countedHere.add(canonical);
        const gap = gaps.get(canonical) ?? { display, jobIds: new Set<string>() };
        gap.jobIds.add(report.jobId);
        gaps.set(canonical, gap);
      }
    }
  }

  const sorted = [...gaps.entries()].sort(
    (a, b) => b[1].jobIds.size - a[1].jobIds.size || a[0].localeCompare(b[0]),
  );

  return sorted.slice(0, MAX_ITEMS).map(([, gap]) => {
    const count = gap.jobIds.size;
    return {
      detector: "missing_keywords",
      severity: "warning",
      title: `${gap.display} — required by ${count} of your ${considered} matched jobs`,
      detail:
        `Your CV never mentions ${gap.display}, but ${count} of the ${considered} ` +
        "jobs you matched list it as a must-have. Do you have real experience " +
        "with it? If yes, add it with a concrete example; if not, leave it " +
        "out — nothing is added automatically.",
    };
  });
}
