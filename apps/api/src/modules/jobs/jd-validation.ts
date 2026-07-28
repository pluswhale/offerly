/**
 * Heuristic "does this paste look like a job description?" check (T6.1).
 * Deliberately simple: length + keyword signals. False positives cost one
 * cheap cached LLM call; false negatives annoy users — thresholds lean lenient.
 */

const JD_SIGNALS = [
  /responsibilit/i,
  /requirements?/i,
  /qualifications?/i,
  /\bexperience\b/i,
  /\bskills?\b/i,
  /about the (role|job|position|team|company)/i,
  /what you('ll| will)/i,
  /we (are looking|'?re looking|seek)/i,
  /\bbenefits?\b/i,
  /\bsalary\b/i,
  /\bapply\b/i,
  /\bteam\b/i,
];

const MIN_CHARS = 200;
const MIN_WORDS = 30;
const MIN_SIGNALS = 2;

export interface JdValidation {
  valid: boolean;
  reason?: string;
}

export function looksLikeJobDescription(text: string): JdValidation {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) {
    return {
      valid: false,
      reason:
        "That looks too short to be a job description — paste the full posting (responsibilities, requirements, …)",
    };
  }
  const words = trimmed.split(/\s+/).length;
  if (words < MIN_WORDS) {
    return {
      valid: false,
      reason: "That doesn't look like a job description — paste the full posting text",
    };
  }
  const signals = JD_SIGNALS.filter((re) => re.test(trimmed)).length;
  if (signals < MIN_SIGNALS) {
    return {
      valid: false,
      reason:
        "That doesn't look like a job description (no responsibilities/requirements found) — paste the full posting",
    };
  }
  return { valid: true };
}

/** Short/vague JDs produce low-confidence matches (T6.2). */
export function isLowConfidenceJd(text: string): boolean {
  return text.trim().length < 400;
}
