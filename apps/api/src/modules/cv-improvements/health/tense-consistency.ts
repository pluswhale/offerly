import { bulletMode, classifyFirstVerb, isBulletLikeLine, stripMarker } from "./bullets.js";
import type { HealthItemDraft } from "./types.js";

/**
 * P1 — Tense consistency (spec 003 §FR-14). Convention: past-tense bullets
 * for past roles, present tense only for the current role. The heuristic is
 * deliberately simple and honest: classify each bullet's first verb (-ed /
 * irregular-past set → past, 3rd-person -s → present, anything else skipped)
 * and flag contiguous bullet runs (a role's bullets are normally contiguous)
 * that mix both. The user-facing message acknowledges the heuristic.
 */

/** At most this many example lines in the item. */
const MAX_EXAMPLES = 3;

export function detectTenseConsistency(cvText: string): HealthItemDraft | null {
  const mode = bulletMode(cvText);

  // Contiguous runs of bullet-like lines ≈ one role's bullets.
  const runs: string[][] = [];
  let current: string[] = [];
  for (const raw of cvText.split(/\r?\n/)) {
    if (isBulletLikeLine(raw, mode)) {
      current.push(stripMarker(raw));
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  let past = 0;
  let present = 0;
  let mixedRuns = 0;
  const examples: string[] = [];
  for (const run of runs) {
    let runPast = 0;
    let runPresent = 0;
    let firstPast: string | null = null;
    let firstPresent: string | null = null;
    for (const line of run) {
      const tense = classifyFirstVerb(line);
      if (tense === "past") {
        runPast += 1;
        past += 1;
        firstPast ??= line;
      } else if (tense === "present") {
        runPresent += 1;
        present += 1;
        firstPresent ??= line;
      }
    }
    if (runPast > 0 && runPresent > 0) {
      mixedRuns += 1;
      if (examples.length < MAX_EXAMPLES && firstPast !== null && firstPresent !== null) {
        examples.push(firstPast, firstPresent);
      }
    }
  }

  if (mixedRuns === 0) return null;

  return {
    detector: "tense_consistency",
    severity: "warning",
    title: "Mixed past and present tense in your bullets",
    detail:
      `${mixedRuns} bullet section(s) mix past-tense openers (${past} bullets) ` +
      `with present-tense ones (${present} bullets). Convention: past tense for ` +
      "past roles, present tense only for your current role. Heuristic: this " +
      "checks the first verb of each bullet (-ed endings vs -s endings) — " +
      "review the examples before editing.",
    examples: examples.slice(0, MAX_EXAMPLES),
  };
}
