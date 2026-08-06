import type {
  ComponentScore,
  RequirementImportance,
  ScoreBreakdown,
  ScoreComponent,
  VerdictValue,
} from "@offerly/types";

/**
 * Explainable-score weights (spec 003 §FR-8), versioned as weights.v1.
 * The score is computed in code from verdicts — the LLM never emits it.
 * Tunable without prompt changes; bump weightsVersion on any change, since
 * (profile version, job content hash, weights version) is the match-reuse key.
 */
export interface ScoreWeights {
  weightsVersion: string;
  /** Per-component weights; MUST sum to 1. */
  components: Record<ScoreComponent, number>;
  /** UNKNOWN scores above MISSING on must-haves: reward clarification, don't
   * punish silence as harshly as absence (spec §FR-8). */
  mustHaveVerdictScores: Record<VerdictValue, number>;
  niceToHaveVerdictScores: Record<VerdictValue, number>;
  /** Confidence gate: report is low_confidence when the share of must-have
   * requirements with verdict 'unknown' EXCEEDS this threshold (spec §FR-8). */
  lowConfidenceUnknownShare: number;
}

export const WEIGHTS_V1: ScoreWeights = {
  weightsVersion: "weights.v1",
  components: {
    must_have: 0.45,
    nice_to_have: 0.2,
    experience: 0.15,
    industry: 0.08,
    location_remote: 0.05,
    languages: 0.04,
    education: 0.03,
  },
  mustHaveVerdictScores: { match: 1.0, partial: 0.5, unknown: 0.35, missing: 0 },
  niceToHaveVerdictScores: { match: 1.0, partial: 0.5, unknown: 0, missing: 0 },
  lowConfidenceUnknownShare: 0.4,
};

/** The minimal verdict info the scorer needs (decoupled from persistence shape). */
export interface ScoredVerdict {
  importance: RequirementImportance;
  verdict: VerdictValue;
}

/** Components not derived from requirement verdicts (deterministic rules / verdicts
 * computed elsewhere), each pre-normalized to 0–1. */
export type StaticComponent = Exclude<ScoreComponent, "must_have" | "nice_to_have">;

export interface ComputedScore {
  score: number;
  weights_version: string;
  breakdown: ScoreBreakdown;
  low_confidence: boolean;
  /** Share of must-have requirements with verdict 'unknown' (0 when no must-haves). */
  unknown_must_have_share: number;
}

/**
 * score = round(100 × Σ(weight × component_score)) (spec §FR-8).
 * Pure and deterministic: identical inputs → identical output.
 *
 * A requirement category with zero requirements scores 1.0 — nothing mandatory
 * is unmet. Components are never redistributed, so breakdown weights always
 * match the weights config.
 */
export function computeScore(
  verdicts: ScoredVerdict[],
  components: Record<StaticComponent, number>,
  weights: ScoreWeights = WEIGHTS_V1,
): ComputedScore {
  const mustHaves = verdicts.filter((v) => v.importance === "must_have");
  const niceToHaves = verdicts.filter((v) => v.importance === "nice_to_have");

  const mustHaveScore = categoryScore(mustHaves, weights.mustHaveVerdictScores);
  const niceToHaveScore = categoryScore(niceToHaves, weights.niceToHaveVerdictScores);
  const unknownMustHaveShare =
    mustHaves.length === 0
      ? 0
      : mustHaves.filter((v) => v.verdict === "unknown").length / mustHaves.length;

  const componentScores: Record<ScoreComponent, number> = {
    must_have: mustHaveScore,
    nice_to_have: niceToHaveScore,
    experience: components.experience,
    industry: components.industry,
    location_remote: components.location_remote,
    languages: components.languages,
    education: components.education,
  };

  let total = 0;
  const breakdown = {} as ScoreBreakdown;
  for (const name of Object.keys(weights.components) as ScoreComponent[]) {
    const weight = weights.components[name];
    const componentScore = componentScores[name];
    const contribution = weight * componentScore;
    total += contribution;
    const entry: ComponentScore = {
      weight,
      component_score: componentScore,
      contribution,
    };
    breakdown[name] = entry;
  }

  return {
    score: Math.round(100 * total),
    weights_version: weights.weightsVersion,
    breakdown,
    low_confidence: unknownMustHaveShare > weights.lowConfidenceUnknownShare,
    unknown_must_have_share: unknownMustHaveShare,
  };
}

function categoryScore(
  verdicts: ScoredVerdict[],
  scores: Record<VerdictValue, number>,
): number {
  if (verdicts.length === 0) return 1.0;
  const sum = verdicts.reduce((acc, v) => acc + scores[v.verdict], 0);
  return sum / verdicts.length;
}
