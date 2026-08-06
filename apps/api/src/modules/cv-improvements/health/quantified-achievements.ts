import { extractBulletLikeLines, startsWithWeakVerb } from "./bullets.js";
import type { HealthItemDraft } from "./types.js";

/**
 * P1 — Quantified-achievement ratio (spec 003 §FR-14). Counts bullet-like
 * lines containing a number ($, %, x, k, plain digits — years and dates are
 * excluded so "2019–2024" doesn't make a bullet "quantified") and reports
 * the ratio plus the weakest unquantified bullets as line references. No
 * rewriting here — that is the bullet improver's job (T5.2).
 */

/** Years/date fragments don't quantify an achievement. */
const YEAR_OR_DATE = /\b(?:19|20)\d{2}\b|\b\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}\b/g;

/** A digit outside a year/date makes the bullet quantified (spec: $, %, x, k, numbers). */
export function isQuantified(line: string): boolean {
  return /\d/.test(line.replace(YEAR_OR_DATE, ""));
}

/** Need at least this many bullets before a ratio is meaningful. */
const MIN_BULLETS = 3;

/** Below this ratio the item is a warning, otherwise informational. */
const WARNING_RATIO = 0.5;

/** At most this many unquantified example bullets. */
const MAX_EXAMPLES = 3;

export function detectQuantifiedAchievements(cvText: string): HealthItemDraft | null {
  const bullets = extractBulletLikeLines(cvText);
  if (bullets.length < MIN_BULLETS) return null;

  const unquantified = bullets.filter((line) => !isQuantified(line));
  if (unquantified.length === 0) return null;

  const quantified = bullets.length - unquantified.length;
  const ratio = quantified / bullets.length;
  const percent = Math.round(ratio * 100);

  // Weakest first: weak-verb openers ("Helped…", "Responsible for…"), then
  // document order — line references only, no rewrites (that's T5.2's job).
  const weakest = [
    ...unquantified.filter((line) => startsWithWeakVerb(line)),
    ...unquantified.filter((line) => !startsWithWeakVerb(line)),
  ].slice(0, MAX_EXAMPLES);

  return {
    detector: "quantified_achievements",
    severity: ratio < WARNING_RATIO ? "warning" : "info",
    title: `${percent}% of your bullets contain a number`,
    detail:
      `${quantified} of ${bullets.length} bullets quantify the achievement ` +
      "(a digit that isn't a year or date — $, %, x, k, counts). Quantified " +
      "bullets correlate with interview rate; add a metric you can defend to " +
      "the unquantified ones below (the bullet improver can help phrase them).",
    examples: weakest,
  };
}
