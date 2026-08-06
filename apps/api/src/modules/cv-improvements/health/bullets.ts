/**
 * Bullet-like line extraction + verb-tense heuristics (spec 003 §FR-14,
 * T5.4), shared by the tense-consistency and quantified-achievements
 * detectors.
 *
 * PDF/DOCX text extraction often drops bullet markers, so "bullet-like" is a
 * two-mode heuristic: explicit markers win when the CV uses them (≥3 marked
 * lines), otherwise verb-initial lines stand in. Both detectors acknowledge
 * the heuristic in their user-facing message.
 */

const BULLET_MARKER = /^[-•*▪◦–—]\s+/;

/** Common irregular past-tense bullet openers (the -ed rule misses these). */
const IRREGULAR_PAST: ReadonlySet<string> = new Set([
  "led",
  "built",
  "wrote",
  "ran",
  "grew",
  "made",
  "took",
  "won",
  "sold",
  "taught",
  "brought",
  "chose",
  "drove",
  "held",
  "kept",
  "left",
  "met",
  "paid",
  "sent",
  "spent",
  "told",
  "spoke",
  "shipped",
]);

/**
 * Weak bullet openers that mark a line as bullet-like even though they are
 * not verbs ("Responsible for…", "Helped…") — used for extraction only, the
 * tense detector still classifies them as "other".
 */
const WEAK_STARTERS: ReadonlySet<string> = new Set([
  "responsible",
  "helped",
  "assisted",
  "participated",
  "worked",
  "supported",
  "involved",
  "tasked",
]);

export type VerbTense = "past" | "present" | "other";

/** First alphabetic word of a line, lowercased ("" when none). */
function firstWord(line: string): string {
  const match = /[\p{L}][\p{L}'-]*/u.exec(line.trim());
  return match === null ? "" : match[0].toLowerCase();
}

/**
 * Verb-ending heuristic: -ed endings and a small irregular set count as
 * past, 3rd-person -s endings as present, everything else is unclassified
 * ("other") rather than guessed.
 */
export function classifyFirstVerb(line: string): VerbTense {
  const word = firstWord(line);
  if (word.length < 3) return "other";
  if (IRREGULAR_PAST.has(word)) return "past";
  if (word.endsWith("ed")) return "past";
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && word.length > 3) {
    return "present";
  }
  return "other";
}

/** True for openers like "Helped…" — bullet-like, but tense-unclassifiable. */
export function startsWithWeakVerb(line: string): boolean {
  return WEAK_STARTERS.has(firstWord(line));
}

/** Lines with an explicit bullet marker, marker stripped, in document order. */
export function extractMarkedBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => BULLET_MARKER.test(line))
    .map((line) => line.replace(BULLET_MARKER, "").trim())
    .filter((line) => line.length > 0);
}

export type BulletMode = "marked" | "verb-initial";

/** Markers win when the CV demonstrably uses them; otherwise verb-initial. */
export function bulletMode(text: string): BulletMode {
  return extractMarkedBullets(text).length >= 3 ? "marked" : "verb-initial";
}

/** Strip a leading bullet marker if present. */
export function stripMarker(line: string): string {
  return line.trim().replace(BULLET_MARKER, "").trim();
}

/** Bullet-likeness of one trimmed-or-raw line under the given mode. */
export function isBulletLikeLine(line: string, mode: BulletMode): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (BULLET_MARKER.test(trimmed)) return true;
  if (mode === "marked") return false;
  return classifyFirstVerb(trimmed) !== "other" || startsWithWeakVerb(trimmed);
}

/**
 * All bullet-like lines (markers stripped, document order). This is the
 * quantified-achievements detector's idea of "the CV's bullets".
 */
export function extractBulletLikeLines(text: string): string[] {
  const mode = bulletMode(text);
  return text
    .split(/\r?\n/)
    .filter((line) => isBulletLikeLine(line, mode))
    .map(stripMarker)
    .filter((line) => line.length > 0);
}
