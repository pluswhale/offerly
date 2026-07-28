import { createHash } from "node:crypto";

/** Cache-key normalization (plan §8.3): lowercase, whitespace collapse, trim. */
export function normalizeForCache(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Rough token estimate (~4 chars/token) — used for streams and cost logging. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

/**
 * Intelligent truncation (plan §8.4): keep the head of the document (CVs/JDs
 * put the most important content first), cut at a paragraph or line boundary
 * so we don't slice mid-sentence, and flag it so the caller can tell the user.
 */
export function truncateText(text: string, maxChars: number): TruncationResult {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  let cut = text.slice(0, maxChars);
  // Backtrack to the last paragraph boundary, then line boundary, if nearby.
  const paragraphBreak = cut.lastIndexOf("\n\n");
  const lineBreak = cut.lastIndexOf("\n");
  const boundary = Math.max(paragraphBreak, lineBreak);
  if (boundary > maxChars * 0.8) {
    cut = cut.slice(0, boundary);
  }
  return { text: `${cut.trimEnd()}\n[...truncated]`, truncated: true };
}
