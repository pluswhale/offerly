import type { HealthItemDraft } from "./types.js";

/**
 * P2 — ATS format lint (spec 003 §FR-14, T5.5). Best-effort detection of
 * layouts that real ATS parsers choke on, inferred from the extracted CV
 * text only — no PDF layout metadata is available at this layer, so every
 * signal is a heuristic and each finding says so. Signals, each reported
 * as its own item:
 *
 *  1. Very few line breaks relative to length — typical of a multi-column
 *     layout extracted as jumbled long lines.
 *  2. Table artifacts — box-drawing characters (│ ┃ ║) or runs of 3+
 *     spaces used as visual column separators.
 *  3. Page headers/footers — standalone page-number lines ("Page 1 of 2").
 *  4. Missing standard section headers (Experience / Education / Skills).
 *
 * Severity: warning when ≥2 signals fire (a real layout problem is likely),
 * info for a single signal. Multi-column and table layouts often parse
 * poorly in ATSs — the details say so; nothing is auto-fixed.
 */

type SignalId = "low_line_breaks" | "table_artifacts" | "page_numbers" | "missing_headers";

interface Signal {
  id: SignalId;
  title: string;
  detail: string;
  examples?: string[];
}

/** Below this total length the line-break ratio is not meaningful. */
const MIN_CHARS_FOR_RATIO = 1500;
/** Average characters per non-empty line above which columns are suspected. */
const MAX_AVG_LINE_CHARS = 250;

const HEURISTIC_NOTE =
  "Heuristic: this is inferred from the extracted text only (the original " +
  "PDF layout is not checked) — if your CV is a simple single-column " +
  "document, dismiss this.";

const ATS_NOTE =
  "Multi-column and table layouts often parse poorly in ATSs — a simple " +
  "single-column layout with standard headings is the safe choice.";

/** Standard header groups an ATS looks for, as lowercase heading lines. */
const STANDARD_HEADERS = [
  {
    label: "Experience",
    headings: ["experience", "work experience", "professional experience", "employment", "employment history", "work history", "career history"],
  },
  {
    label: "Education",
    headings: ["education", "academic background", "academic history", "education and training"],
  },
  {
    label: "Skills",
    headings: ["skills", "technical skills", "core skills", "key skills", "core competencies", "technologies", "tech stack"],
  },
] as const;

function headingOf(line: string): string {
  return line.trim().replace(/:+$/, "").toLowerCase().replace(/\s+/g, " ");
}

function collectSignals(cvText: string): Signal[] {
  const lines = cvText.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const signals: Signal[] = [];

  // 1. Line-break ratio — a wall of text with almost no breaks is how
  //    multi-column PDFs come out of extraction.
  if (cvText.length >= MIN_CHARS_FOR_RATIO && nonEmpty.length > 0) {
    const avg = cvText.length / nonEmpty.length;
    if (avg > MAX_AVG_LINE_CHARS) {
      signals.push({
        id: "low_line_breaks",
        title: "Very long lines — possible multi-column layout",
        detail:
          `The extracted text averages ~${Math.round(avg)} characters per line, ` +
          "which usually means a multi-column layout was flattened into jumbled " +
          `lines. ${ATS_NOTE} ${HEURISTIC_NOTE}`,
      });
    }
  }

  // 2. Table artifacts — box-drawing characters, or interior runs of 3+
  //    spaces standing in for column separators.
  const boxLines = nonEmpty.filter((line) => /[│┃║]/.test(line));
  const spaceColumnLines = nonEmpty.filter((line) => /\S {3,}\S/.test(line));
  if (boxLines.length > 0 || spaceColumnLines.length >= 2) {
    const evidence = [...boxLines, ...spaceColumnLines]
      .map((line) => line.trim().replace(/ {3,}/g, " ⏐ "))
      .slice(0, 3);
    signals.push({
      id: "table_artifacts",
      title: "Table or column artifacts in the extracted text",
      detail:
        "The text contains table/column marks (box-drawing characters or wide " +
        `space gaps), so parts of the CV are probably laid out as a table. ${ATS_NOTE} ` +
        HEURISTIC_NOTE,
      ...(evidence.length > 0 ? { examples: evidence } : {}),
    });
  }

  // 3. Page headers/footers — explicit "Page N" lines, or several bare
  //    standalone numbers (a single one could be legitimate content).
  const pageWordLines = nonEmpty.filter((line) =>
    /^\s*page\s+\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?\s*$/i.test(line),
  );
  const bareNumberLines = nonEmpty.filter((line) => /^\s*\d{1,3}\s*$/.test(line));
  if (pageWordLines.length > 0 || bareNumberLines.length >= 2) {
    const evidence = [...pageWordLines, ...bareNumberLines].map((line) => line.trim()).slice(0, 3);
    signals.push({
      id: "page_numbers",
      title: "Possible page headers or footers in the text",
      detail:
        "Standalone page-number lines suggest the CV's page header/footer was " +
        "extracted as content — ATSs may read those numbers into the middle of " +
        `sentences. Remove page numbering from the header/footer. ${HEURISTIC_NOTE}`,
      ...(evidence.length > 0 ? { examples: evidence } : {}),
    });
  }

  // 4. Missing standard section headers — a line that IS the heading (not
  //    merely contains the word) counts as present.
  const headings = new Set(nonEmpty.map(headingOf));
  const missing = STANDARD_HEADERS.filter(
    (group) => !group.headings.some((heading) => headings.has(heading)),
  ).map((group) => group.label);
  if (missing.length > 0) {
    signals.push({
      id: "missing_headers",
      title: `Standard section headers not found: ${missing.join(", ")}`,
      detail:
        "ATSs section a CV by looking for standard headings. No " +
        `${missing.join(" / ")} heading was found as its own line — use the ` +
        `conventional names ("Experience", "Education", "Skills"). ${HEURISTIC_NOTE}`,
    });
  }

  return signals;
}

export function detectAtsFormat(cvText: string): HealthItemDraft[] {
  const signals = collectSignals(cvText);
  const severity = signals.length >= 2 ? "warning" : "info";
  return signals.map((signal) => ({
    detector: "ats_format",
    severity,
    title: signal.title,
    detail: signal.detail,
    ...(signal.examples !== undefined ? { examples: signal.examples } : {}),
  }));
}
