import type { HealthItemDraft } from "./types.js";

/**
 * P1 — Date-format consistency (spec 003 §FR-14). Detects mixed date-format
 * families in the CV text (01/2020 vs 2020-01 vs Jan 2020 vs January 2020)
 * and reports which were found. Recruiters and ATS parsers notice mixed
 * formats; the detector only reports — it never rewrites.
 */

interface DateFamily {
  id: string;
  label: string;
  re: RegExp;
}

const DATE_FAMILIES: readonly DateFamily[] = [
  {
    id: "numeric_slash",
    label: "MM/YYYY",
    re: /\b\d{1,2}\/\d{4}\b/g,
  },
  {
    id: "iso_dash",
    label: "YYYY-MM",
    re: /\b\d{4}-\d{2}\b/g,
  },
  {
    // Long names first; "May" is counted here, not as a short month, so the
    // two families never double-count the same occurrence.
    id: "month_long",
    label: "Month YYYY",
    re: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
  },
  {
    id: "month_short",
    label: "Mon YYYY",
    re: /\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{4}\b/gi,
  },
];

/** At most this many sample occurrences per family in the examples. */
const MAX_SAMPLES_PER_FAMILY = 2;

export function detectDateFormats(cvText: string): HealthItemDraft | null {
  const found: { family: DateFamily; count: number; samples: string[] }[] = [];
  for (const family of DATE_FAMILIES) {
    const matches = cvText.match(family.re) ?? [];
    if (matches.length > 0) {
      found.push({ family, count: matches.length, samples: matches.slice(0, MAX_SAMPLES_PER_FAMILY) });
    }
  }

  if (found.length < 2) return null;

  const summary = found.map((f) => `${f.family.label} ×${f.count}`).join(", ");
  return {
    detector: "date_format_consistency",
    severity: "warning",
    title: `Mixed date formats (${found.length} styles found)`,
    detail:
      `Your CV mixes date formats: ${summary}. Pick one format and use it ` +
      "everywhere — inconsistent dates are recruiter-visible polish and can " +
      "confuse ATS parsers.",
    examples: found.flatMap((f) => f.samples.map((s) => `${s} (${f.family.label})`)),
  };
}
