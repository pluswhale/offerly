import type { CandidateProfile, RequirementVerdict, VerdictValue } from "@offerly/types";
import type { EvidenceVerificationReport } from "../../src/modules/ai/evidence.js";
import { isEvidencedLeaf, parseProfilePath } from "../../src/modules/ai/profile-paths.js";
import { normalizeForMatch } from "../../src/modules/ai/text.js";
import type { CvExpectation, PairFixture } from "./dataset.js";

/**
 * Benchmark metrics (spec 003 §10, T2.6): schema validity, evidence-verbatim
 * rate, per-field precision/recall against the human-labeled expected.json,
 * and UNKNOWN-correctness (expected-unknown fields must not be invented).
 * Pure functions — no I/O, no provider access.
 */

export interface StatedFailure {
  path: string;
  expected: string;
  actual: string;
}

export interface ValidationSummary {
  /** Items S3 would adjudicate (S2 flags + low confidence + consistency). */
  items: number;
  adjudicated: number;
  /** Human note, e.g. why adjudication was skipped in replay mode. */
  note: string | null;
}

export interface FixtureMetrics {
  name: string;
  /** False when the pipeline produced no schema-valid profile (or errored). */
  schemaValid: boolean;
  error: string | null;
  evidenceVerified: number;
  evidenceTotal: number;
  /** Stated-field confusion counts (micro): tp/fn over expected values, fp over unexpected extras. */
  tp: number;
  fp: number;
  fn: number;
  failedStated: StatedFailure[];
  /** Extracted array members that were not expected (precision loss). */
  extras: Array<{ path: string; values: string[] }>;
  unknownTotal: number;
  unknownCorrect: number;
  /** Expected-unknown fields that were invented — the headline honesty metric. */
  invented: Array<{ path: string; actual: string }>;
  validation: ValidationSummary;
  tokensIn: number;
  tokensOut: number;
}

export interface AggregateMetrics {
  fixtureCount: number;
  schemaValidCount: number;
  evidenceVerified: number;
  evidenceTotal: number;
  tp: number;
  fp: number;
  fn: number;
  unknownTotal: number;
  unknownCorrect: number;
  inventedCount: number;
}

/** CI hard floors (spec 003 §10 / AC-1/AC-2 + T3.3 verdict accuracy). */
export interface HardFloors {
  /** 100% schema validity. */
  schemaValid: boolean;
  /** 100% of stated facts' evidence verifies verbatim. */
  evidenceVerbatim: boolean;
  /** Zero invented expected-unknown fields. */
  unknownRespected: boolean;
  /** 100% verdict accuracy on recorded CV×JD pairs (recordings encode the labels). */
  verdictAccuracy: boolean;
}

/* ---------------- CV×JD verdict pairs (T3.3) ---------------- */

export interface VerdictMismatch {
  requirement_id: string;
  expected: VerdictValue;
  /** The produced verdict, or "absent" when no verdict was emitted for the id. */
  actual: VerdictValue | "absent";
}

export interface PairMetrics {
  name: string;
  cv: string;
  jd: string;
  /** False when extraction/matching errored (no schema-valid verdicts). */
  schemaValid: boolean;
  error: string | null;
  /** Requirements scored against expectations. */
  total: number;
  correct: number;
  /** Requirements that went to the LLM pass (the rest were pre-pass-resolved). */
  unresolvedCount: number;
  mismatches: VerdictMismatch[];
  /**
   * The load-bearing confusion (spec §FR-7): expected UNKNOWN but got MISSING
   * or vice versa — reported separately from plain accuracy. Subset of
   * mismatches.
   */
  unknownMissingConfusions: VerdictMismatch[];
}

export interface PairAggregateMetrics {
  pairCount: number;
  total: number;
  correct: number;
  unknownMissingConfusions: number;
}

/** Score produced verdicts (pre-pass + LLM) against the pair's expectations. */
export function computePairMetrics(
  pair: PairFixture,
  verdicts: readonly RequirementVerdict[],
  unresolvedCount: number,
): PairMetrics {
  const byId = new Map(verdicts.map((v) => [v.requirement_id, v.verdict]));
  const mismatches: VerdictMismatch[] = [];
  const confusions: VerdictMismatch[] = [];
  let correct = 0;
  let total = 0;
  for (const [id, expected] of Object.entries(pair.expectedVerdicts)) {
    total += 1;
    const actual = byId.get(id) ?? "absent";
    if (actual === expected) {
      correct += 1;
      continue;
    }
    const mismatch: VerdictMismatch = { requirement_id: id, expected, actual };
    mismatches.push(mismatch);
    const isConfusion =
      (expected === "unknown" && actual === "missing") ||
      (expected === "missing" && actual === "unknown");
    if (isConfusion) confusions.push(mismatch);
  }
  return {
    name: pair.name,
    cv: pair.cv,
    jd: pair.jd,
    schemaValid: true,
    error: null,
    total,
    correct,
    unresolvedCount,
    mismatches,
    unknownMissingConfusions: confusions,
  };
}

/** Metrics for a pair whose run errored before producing verdicts. */
export function failedPairMetrics(pair: PairFixture, err: unknown): PairMetrics {
  return {
    name: pair.name,
    cv: pair.cv,
    jd: pair.jd,
    schemaValid: false,
    error: err instanceof Error ? err.message : String(err),
    total: Object.keys(pair.expectedVerdicts).length,
    correct: 0,
    unresolvedCount: 0,
    mismatches: [],
    unknownMissingConfusions: [],
  };
}

export function aggregatePairMetrics(pairs: PairMetrics[]): PairAggregateMetrics {
  const aggregate: PairAggregateMetrics = {
    pairCount: pairs.length,
    total: 0,
    correct: 0,
    unknownMissingConfusions: 0,
  };
  for (const pair of pairs) {
    aggregate.total += pair.total;
    aggregate.correct += pair.correct;
    aggregate.unknownMissingConfusions += pair.unknownMissingConfusions.length;
  }
  return aggregate;
}

/** Object-array item field that carries the display value, per profile path. */
const ITEM_VALUE_FIELD: Record<string, string> = {
  languages: "language",
  certifications: "name",
  education: "degree",
  roles: "title",
};

function resolveAtPath(root: unknown, path: string): unknown {
  const tokens = parseProfilePath(path);
  if (!tokens) return undefined;
  let node: unknown = root;
  for (const token of tokens) {
    if (node === null || typeof node !== "object") return undefined;
    node =
      typeof token === "number"
        ? Array.isArray(node)
          ? node[token]
          : undefined
        : (node as Record<string, unknown>)[token];
    if (node === undefined || node === null) return node;
  }
  return node;
}

/**
 * Member values of an array-of-facts path: Evidenced arrays resolve via the
 * leaf value, object arrays (languages, education, …) via their display field.
 * Null when the path does not resolve to a supported array.
 */
function arrayValuesAtPath(profile: CandidateProfile, path: string): string[] | null {
  const node = resolveAtPath(profile, path);
  if (!Array.isArray(node)) return null;
  const values: string[] = [];
  for (const item of node) {
    if (isEvidencedLeaf(item)) {
      if (typeof item.value === "string") values.push(item.value);
      continue;
    }
    const field = ITEM_VALUE_FIELD[path];
    if (!field) return null;
    const leaf = resolveAtPath(item, field);
    if (!isEvidencedLeaf(leaf)) return null;
    if (typeof leaf.value === "string") values.push(leaf.value);
  }
  return values;
}

/** Expected-unknown check: array paths must be empty, scalar leaves must be status 'unknown'. */
function checkUnknown(
  profile: CandidateProfile,
  path: string,
): { pass: boolean; actual: string } {
  const node = resolveAtPath(profile, path);
  if (Array.isArray(node)) {
    return { pass: node.length === 0, actual: `[${node.length} item(s)]` };
  }
  if (isEvidencedLeaf(node)) {
    const pass = node.status === "unknown" && node.value === null;
    return { pass, actual: `status=${node.status} value=${JSON.stringify(node.value ?? null)}` };
  }
  return { pass: false, actual: "path not found" };
}

/** Score one extracted profile against its human-labeled expectations. */
export function computeFixtureMetrics(
  name: string,
  profile: CandidateProfile,
  expected: CvExpectation,
  evidence: EvidenceVerificationReport,
  validation: ValidationSummary,
  tokens: { tokensIn: number; tokensOut: number },
): FixtureMetrics {
  const failedStated: StatedFailure[] = [];
  const extras: Array<{ path: string; values: string[] }> = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const [path, expectation] of Object.entries(expected.stated)) {
    if (Array.isArray(expectation)) {
      const actual = arrayValuesAtPath(profile, path);
      if (actual === null) {
        fn += expectation.length;
        failedStated.push({
          path,
          expected: expectation.join(", "),
          actual: "(path is not a supported array)",
        });
        continue;
      }
      const actualNorm = new Set(actual.map(normalizeForMatch));
      const expectedNorm = new Set(expectation.map(normalizeForMatch));
      for (const value of expectation) {
        if (actualNorm.has(normalizeForMatch(value))) {
          tp += 1;
        } else {
          fn += 1;
          failedStated.push({ path: `${path}[]`, expected: value, actual: "(missing)" });
        }
      }
      const extra = actual.filter((value) => !expectedNorm.has(normalizeForMatch(value)));
      fp += extra.length;
      if (extra.length > 0) extras.push({ path, values: extra });
      continue;
    }

    const leaf = resolveAtPath(profile, path);
    const expectedText = String(expectation);
    const pass =
      isEvidencedLeaf(leaf) &&
      leaf.status === "stated" &&
      leaf.value !== null &&
      normalizeForMatch(String(leaf.value)) === normalizeForMatch(expectedText);
    if (pass) {
      tp += 1;
    } else {
      fn += 1;
      failedStated.push({
        path,
        expected: expectedText,
        actual: isEvidencedLeaf(leaf)
          ? `status=${leaf.status} value=${JSON.stringify(leaf.value ?? null)}`
          : "(path not found)",
      });
    }
  }

  const invented: Array<{ path: string; actual: string }> = [];
  let unknownCorrect = 0;
  for (const path of expected.unknown) {
    const check = checkUnknown(profile, path);
    if (check.pass) unknownCorrect += 1;
    else invented.push({ path, actual: check.actual });
  }

  return {
    name,
    schemaValid: true,
    error: null,
    evidenceVerified: evidence.verifiedCount,
    evidenceTotal: evidence.totalCount,
    tp,
    fp,
    fn,
    failedStated,
    extras,
    unknownTotal: expected.unknown.length,
    unknownCorrect,
    invented,
    validation,
    tokensIn: tokens.tokensIn,
    tokensOut: tokens.tokensOut,
  };
}

/** Metrics for a fixture whose run produced no schema-valid profile. */
export function failedFixtureMetrics(name: string, err: unknown): FixtureMetrics {
  return {
    name,
    schemaValid: false,
    error: err instanceof Error ? err.message : String(err),
    evidenceVerified: 0,
    evidenceTotal: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    failedStated: [],
    extras: [],
    unknownTotal: 0,
    unknownCorrect: 0,
    invented: [],
    validation: { items: 0, adjudicated: 0, note: null },
    tokensIn: 0,
    tokensOut: 0,
  };
}

export function aggregateMetrics(fixtures: FixtureMetrics[]): AggregateMetrics {
  const aggregate: AggregateMetrics = {
    fixtureCount: fixtures.length,
    schemaValidCount: 0,
    evidenceVerified: 0,
    evidenceTotal: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    unknownTotal: 0,
    unknownCorrect: 0,
    inventedCount: 0,
  };
  for (const f of fixtures) {
    if (f.schemaValid) aggregate.schemaValidCount += 1;
    aggregate.evidenceVerified += f.evidenceVerified;
    aggregate.evidenceTotal += f.evidenceTotal;
    aggregate.tp += f.tp;
    aggregate.fp += f.fp;
    aggregate.fn += f.fn;
    aggregate.unknownTotal += f.unknownTotal;
    aggregate.unknownCorrect += f.unknownCorrect;
    aggregate.inventedCount += f.invented.length;
  }
  return aggregate;
}

/** The CI floor check (spec §10): all four must hold on recorded fixtures. */
export function checkHardFloors(
  aggregate: AggregateMetrics,
  pairs: PairAggregateMetrics,
): HardFloors {
  return {
    schemaValid: aggregate.fixtureCount > 0 && aggregate.schemaValidCount === aggregate.fixtureCount,
    evidenceVerbatim:
      aggregate.evidenceTotal > 0 && aggregate.evidenceVerified === aggregate.evidenceTotal,
    unknownRespected: aggregate.inventedCount === 0,
    // Recordings encode the labels, so anything below 100% is a regression;
    // total > 0 guards against a vacuous pass on an empty pair dataset.
    verdictAccuracy: pairs.total > 0 && pairs.correct === pairs.total,
  };
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function precision(m: { tp: number; fp: number }): number | null {
  return ratio(m.tp, m.tp + m.fp);
}

export function recall(m: { tp: number; fn: number }): number | null {
  return ratio(m.tp, m.tp + m.fn);
}
