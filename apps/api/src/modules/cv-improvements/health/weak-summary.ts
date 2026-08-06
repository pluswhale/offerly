import type { HealthItemDraft } from "./types.js";

/**
 * P2 — Weak summary detection (spec 003 §FR-14, T5.5). Locates the
 * summary/about section by its heading (summary / profile / about /
 * objective, case-insensitive) and flags the three classic problems:
 * absent entirely (info), longer than 80 words (warning), or written in
 * the first person (warning). Report-only — nothing is rewritten here;
 * rewriting is the sentence/bullet improver's job.
 *
 * Heuristic limits: the section runs from its heading to the next
 * heading-like line (all-caps-ish or a known section word). A CV with an
 * unusually styled heading may have its summary measured short or long;
 * the user can always dismiss the item.
 */

/** Headings that introduce the summary section (compared lowercase, colon stripped). */
const SUMMARY_HEADERS: readonly string[] = [
  "summary",
  "professional summary",
  "career summary",
  "profile",
  "personal profile",
  "professional profile",
  "about",
  "about me",
  "objective",
  "career objective",
];

/** Known non-summary section headings that terminate the summary block. */
const SECTION_HEADERS: readonly string[] = [
  ...SUMMARY_HEADERS,
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "employment history",
  "work history",
  "career history",
  "education",
  "academic background",
  "skills",
  "technical skills",
  "core competencies",
  "key skills",
  "projects",
  "certifications",
  "certificates",
  "languages",
  "references",
  "awards",
  "publications",
  "interests",
  "contact",
];

/** Summary longer than this is flagged. */
const MAX_WORDS = 80;
/** Examples show at most the first this many words of the summary. */
const EXAMPLE_WORDS = 30;
/** Heading-like lines are short. */
const MAX_HEADER_CHARS = 60;

/** "SUMMARY", "WORK EXPERIENCE" — mostly uppercase letters, at least 3. */
function isAllCapsish(line: string): boolean {
  const letters = line.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 3) return false;
  const upper = line.replace(/[^a-zA-Z]/g, "").replace(/[^A-Z]/g, "");
  return upper.length / letters.length >= 0.7;
}

/** Normalize a line for heading comparison: trim, drop a trailing colon, lowercase. */
function asHeading(line: string): string {
  return line.trim().replace(/:+$/, "").toLowerCase().replace(/\s+/g, " ");
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADER_CHARS) return false;
  if (SECTION_HEADERS.includes(asHeading(trimmed))) return true;
  return isAllCapsish(trimmed);
}

interface SummarySection {
  /** Section body lines (heading excluded). */
  body: string;
  wordCount: number;
}

/** Find the summary section: heading line, then body until the next heading-like line. */
function findSummary(cvText: string): SummarySection | null {
  const lines = cvText.split(/\r?\n/);
  const start = lines.findIndex((line) => SUMMARY_HEADERS.includes(asHeading(line)));
  if (start === -1) return null;

  const bodyLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isHeadingLine(line)) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join(" ").replace(/\s+/g, " ").trim();
  const wordCount = body.length === 0 ? 0 : body.split(" ").length;
  return { body, wordCount };
}

function openingExample(body: string): string {
  const words = body.split(" ");
  const head = words.slice(0, EXAMPLE_WORDS).join(" ");
  return words.length > EXAMPLE_WORDS ? `${head} …` : head;
}

/** First-person markers ("I am", "my", "I'm"…) — CV convention is implied first person. */
const FIRST_PERSON_RE = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself)\b/i;

export function detectWeakSummary(cvText: string): HealthItemDraft[] {
  const summary = findSummary(cvText);

  if (summary === null) {
    return [
      {
        detector: "weak_summary",
        severity: "info",
        title: "No summary section found",
        detail:
          "The summary is the most-read part of a CV — add 2–3 lines at the top " +
          "saying who you are, your specialty, and your experience level. " +
          "(Heuristic: looked for a 'Summary', 'Profile', 'About' or 'Objective' heading.)",
      },
    ];
  }

  const items: HealthItemDraft[] = [];
  const example = summary.body.length > 0 ? [openingExample(summary.body)] : undefined;

  if (summary.wordCount > MAX_WORDS) {
    items.push({
      detector: "weak_summary",
      severity: "warning",
      title: `Summary is too long (${summary.wordCount} words)`,
      detail:
        `Recruiters skim — keep the summary under ~${MAX_WORDS} words (2–4 lines). ` +
        `Yours has ${summary.wordCount}; cut everything that doesn't say who you ` +
        "are and what you do best.",
      ...(example !== undefined ? { examples: example } : {}),
    });
  }

  if (summary.body.length > 0 && FIRST_PERSON_RE.test(summary.body)) {
    items.push({
      detector: "weak_summary",
      severity: "warning",
      title: "Summary is written in the first person",
      detail:
        "CV convention is implied first person — \"Backend engineer with 8 years…\", " +
        "not \"I am a backend engineer…\". First-person pronouns (\"I\", \"my\") read " +
        "as less polished to recruiters.",
      ...(example !== undefined ? { examples: example } : {}),
    });
  }

  return items;
}
