import { TECH_ALIASES } from "../ai/matching/aliases.js";
import { containsPhrase } from "../ai/matching/prepass.js";
import { normalizeForMatch } from "../ai/text.js";

/**
 * Deterministic new-entity guard for bullet rewrites (spec 003 §FR-13, T5.2):
 * a rewrite may rephrase and restructure but never add facts, so any named
 * technology/product/company in `improved` that is absent from the original
 * span marks the suggestion as hallucinated — the service drops it.
 *
 * Entities are detected two ways:
 *  1. Tech lexicon — every TECH_ALIASES key is matched against the normalized
 *     text with tech-aware token boundaries (the same containsPhrase the
 *     matching pre-pass uses, so "c++", "c#" and "node.js" don't misfire).
 *     Aliases fold to their canonical form, so "k8s" in the original covers
 *     "Kubernetes" in the rewrite — same entity, not a new one.
 *  2. Proper-noun heuristic — maximal runs of ≥2 capitalized tokens in the
 *     raw text ("Google Cloud", "Acme Corp"), first token exempt when
 *     sentence-initial (every English sentence starts capitalized). The run
 *     must appear in the original span (case-insensitively) to pass.
 *
 * Known limits (heuristic, documented per task): single-token proper nouns
 * outside the tech lexicon are NOT caught (a fabricated "Globex" passes —
 * the verbatim-span check and the prompt's no-new-facts rule are the other
 * layers); ALL-CAPS acronyms outside the lexicon pass too; and a legitimate
 * multiword phrase the model capitalizes differently can false-positive.
 * The guard is deliberately conservative in what it *flags*: dropping a good
 * suggestion costs less than storing a hallucinated one.
 *
 * Bracketed placeholders ("by [X]%", "serving [N] users") are exempt — they
 * are user fill-ins, not claims (spec §FR-13 honesty rule).
 */

/** Remove [bracketed] placeholder spans so their contents are never entity-checked. */
function stripPlaceholders(text: string): string {
  return text.replace(/\[[^\][]*\]/g, " ");
}

/**
 * Lexicon keys that are also common English words. Boundary-aware matching
 * keeps "said" from hitting "ai", but standalone prose uses ("the next
 * release", "at the helm") would false-positive as Next.js / Helm and drop
 * good suggestions — a miss costs less than a wrong drop, so these keys are
 * skipped. The proper-noun heuristic still catches their capitalized forms
 * in multiword phrases.
 */
const PROSE_WORD_KEYS: ReadonlySet<string> = new Set([
  "next",
  "go",
  "rest",
  "spring",
  "spark",
  "helm",
  "express",
]);

/** Canonical tech entities mentioned in a text (alias-folded, boundary-aware). */
function techEntitiesIn(text: string): Set<string> {
  const normalized = normalizeForMatch(stripPlaceholders(text));
  const found = new Set<string>();
  for (const [alias, canonical] of Object.entries(TECH_ALIASES)) {
    if (PROSE_WORD_KEYS.has(alias)) continue;
    if (containsPhrase(normalized, alias)) found.add(canonical);
  }
  return found;
}

/** A word, possibly with tech-style internal separators ("node.js", "ci/cd"). */
const WORD_RE = /[\p{L}\p{N}]+(?:[.'+#/-][\p{L}\p{N}]+)*/u;

/** Punctuation that ends a sentence/bullet when it sits between two words. */
const BOUNDARY_RE = /[\n.!?;:•*\-–—]/;

interface CapitalizedRun {
  tokens: string[];
  sentenceInitialStart: boolean;
}

/**
 * Maximal runs of consecutive capitalized words in raw text. A run is broken
 * by anything but pure whitespace between words; sentence-initial means the
 * run starts after a sentence/bullet boundary (or the start of the text).
 */
function capitalizedRuns(text: string): CapitalizedRun[] {
  const tokens: Array<{ word: string; gap: string }> = [];
  const re = new RegExp(WORD_RE.source, "gu");
  let prevEnd = 0;
  for (const match of text.matchAll(re)) {
    tokens.push({ word: match[0], gap: text.slice(prevEnd, match.index) });
    prevEnd = match.index + match[0].length;
  }

  const runs: CapitalizedRun[] = [];
  let current: CapitalizedRun | null = null;
  for (const [i, token] of tokens.entries()) {
    const capitalized = /^[\p{Lu}\p{Lt}]/u.test(token.word);
    if (capitalized && current !== null && /^\s+$/.test(token.gap)) {
      current.tokens.push(token.word);
    } else if (capitalized) {
      const boundary = i === 0 || BOUNDARY_RE.test(token.gap);
      current = { tokens: [token.word], sentenceInitialStart: boundary };
      runs.push(current);
    } else {
      current = null;
    }
  }
  return runs;
}

/**
 * Multiword proper-noun phrases ("Google Cloud", "Acme Corp") in a text.
 * The leading token is dropped when sentence-initial — it is capitalized by
 * grammar, not by being a name.
 */
function properNounPhrasesIn(text: string): string[] {
  const stripped = stripPlaceholders(text);
  const phrases: string[] = [];
  for (const run of capitalizedRuns(stripped)) {
    const tokens = run.sentenceInitialStart ? run.tokens.slice(1) : run.tokens;
    if (tokens.length >= 2) phrases.push(tokens.join(" "));
  }
  return phrases;
}

/**
 * Entities claimed by `improved` that are absent from `originalSpan`.
 * An empty result means the rewrite introduces no new named technology,
 * product, or company — it passed the guard.
 */
export function findNewEntities(originalSpan: string, improved: string): string[] {
  const violations: string[] = [];

  const originalTech = techEntitiesIn(originalSpan);
  for (const entity of techEntitiesIn(improved)) {
    if (!originalTech.has(entity)) violations.push(entity);
  }

  const originalNormalized = normalizeForMatch(stripPlaceholders(originalSpan));
  for (const phrase of properNounPhrasesIn(improved)) {
    if (!containsPhrase(originalNormalized, normalizeForMatch(phrase))) {
      violations.push(phrase);
    }
  }
  return violations;
}
