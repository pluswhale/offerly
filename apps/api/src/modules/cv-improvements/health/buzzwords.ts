import type { HealthItemDraft } from "./types.js";

/**
 * P1 — Overused buzzwords (spec 003 §FR-14). Counts case-insensitive
 * occurrences of a configurable cliché list (hyphen/space variants fold
 * together) and flags when any single buzzword appears ≥2 times or the
 * total reaches 3. Show-don't-tell advice only — nothing is rewritten here.
 */

/** Default cliché list; callers may pass their own (configurable by design). */
export const DEFAULT_BUZZWORDS: readonly string[] = [
  "team player",
  "results-driven",
  "hard-working",
  "synergy",
  "go-getter",
  "detail-oriented",
  "thought leader",
  "ninja",
  "guru",
  "rockstar",
  "fast learner",
  "self-starter",
  "think outside the box",
  "best of breed",
  "team-player",
];

/** Flag when one buzzword hits this count, or the grand total does. */
const SINGLE_THRESHOLD = 2;
const TOTAL_THRESHOLD = 3;

/** At most this many example lines in the item. */
const MAX_EXAMPLES = 3;

/** Fold hyphens/dashes to spaces so "results-driven" ≈ "results driven". */
function fold(text: string): string {
  return text.toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "gu");
  return (haystack.match(re) ?? []).length;
}

export function detectBuzzwords(
  cvText: string,
  buzzwords: readonly string[] = DEFAULT_BUZZWORDS,
): HealthItemDraft | null {
  const foldedText = fold(cvText);
  // Dedupe by folded form first — "team player" and "team-player" are the
  // same needle after folding and must not double-count one occurrence.
  const needles = new Map<string, string>(); // folded needle → display form
  for (const word of buzzwords) {
    const folded = fold(word);
    if (!needles.has(folded)) needles.set(folded, folded.replace(/\s+/g, "-"));
  }
  const counts = new Map<string, number>(); // display form → total count
  let total = 0;
  for (const [needle, display] of needles) {
    const count = countOccurrences(foldedText, needle);
    if (count > 0) {
      counts.set(display, count);
      total += count;
    }
  }

  const hits = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const worst = hits[0];
  if (worst === undefined) return null;
  if (worst[1] < SINGLE_THRESHOLD && total < TOTAL_THRESHOLD) return null;

  // Example lines: first CV line containing each of the top buzzwords.
  const lines = cvText.split(/\r?\n/);
  const examples: string[] = [];
  for (const [display] of hits) {
    if (examples.length >= MAX_EXAMPLES) break;
    const needle = fold(display).replace(/-/g, " ");
    const line = lines.find((candidate) => fold(candidate).includes(needle));
    if (line !== undefined && line.trim().length > 0) examples.push(line.trim());
  }

  const summary = hits.map(([display, count]) => `"${display}" ×${count}`).join(", ");
  return {
    detector: "buzzwords",
    severity: "warning",
    title: `Overused buzzwords (${total} occurrence${total === 1 ? "" : "s"})`,
    detail:
      `Clichés recruiters and ATSs discount: ${summary}. Show, don't tell — ` +
      "replace them with the concrete achievement that demonstrates the trait.",
    ...(examples.length > 0 ? { examples } : {}),
  };
}
