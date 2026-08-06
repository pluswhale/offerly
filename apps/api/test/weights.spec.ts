import { describe, expect, it } from "vitest";
import {
  computeScore,
  WEIGHTS_V1,
  type ScoredVerdict,
  type StaticComponent,
} from "../src/modules/ai/matching/weights.js";

const PERFECT_COMPONENTS: Record<StaticComponent, number> = {
  experience: 1,
  industry: 1,
  location_remote: 1,
  languages: 1,
  education: 1,
};

const v = (
  importance: "must_have" | "nice_to_have",
  verdict: "match" | "partial" | "unknown" | "missing",
): ScoredVerdict => ({ importance, verdict });

describe("WEIGHTS_V1 (spec §FR-8)", () => {
  it("matches the spec table and sums to 1", () => {
    expect(WEIGHTS_V1.weightsVersion).toBe("weights.v1");
    expect(WEIGHTS_V1.components).toEqual({
      must_have: 0.45,
      nice_to_have: 0.2,
      experience: 0.15,
      industry: 0.08,
      location_remote: 0.05,
      languages: 0.04,
      education: 0.03,
    });
    const sum = Object.values(WEIGHTS_V1.components).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(WEIGHTS_V1.mustHaveVerdictScores).toEqual({
      match: 1.0,
      partial: 0.5,
      unknown: 0.35,
      missing: 0,
    });
    expect(WEIGHTS_V1.niceToHaveVerdictScores).toEqual({
      match: 1.0,
      partial: 0.5,
      unknown: 0,
      missing: 0,
    });
  });
});

describe("computeScore golden vectors (T1.3)", () => {
  it("all-match → 100", () => {
    const result = computeScore(
      [v("must_have", "match"), v("must_have", "match"), v("nice_to_have", "match")],
      PERFECT_COMPONENTS,
    );
    expect(result.score).toBe(100);
    expect(result.weights_version).toBe("weights.v1");
    expect(result.low_confidence).toBe(false);
    expect(result.unknown_must_have_share).toBe(0);
  });

  it("all-missing must-haves → capped low score (0 from the 45% must-have block)", () => {
    const result = computeScore(
      [v("must_have", "missing"), v("must_have", "missing"), v("nice_to_have", "match")],
      PERFECT_COMPONENTS,
    );
    // Only the non-must-have weights can contribute: 20+15+8+5+4+3 = 55.
    expect(result.score).toBe(55);
    expect(result.breakdown.must_have.component_score).toBe(0);
    expect(result.breakdown.must_have.contribution).toBe(0);
  });

  it("unknown scores above missing on must-haves (0.35)", () => {
    const unknown = computeScore([v("must_have", "unknown")], PERFECT_COMPONENTS);
    const missing = computeScore([v("must_have", "missing")], PERFECT_COMPONENTS);
    // 0.45×0.35 + 0.55 = 0.7075 → 71 vs 0.55 → 55.
    expect(unknown.score).toBe(71);
    expect(missing.score).toBe(55);
    expect(unknown.score).toBeGreaterThan(missing.score);
  });

  it("unknown scores 0 on nice-to-haves, partial scores 0.5 everywhere", () => {
    const unknownNice = computeScore([v("nice_to_have", "unknown")], PERFECT_COMPONENTS);
    const partialNice = computeScore([v("nice_to_have", "partial")], PERFECT_COMPONENTS);
    // no must-haves → that block contributes its full 45 (vacuous)
    expect(unknownNice.score).toBe(100 - 20); // 0.2×0 lost
    expect(partialNice.score).toBe(100 - 10); // 0.2×0.5 lost
  });

  it("empty verdict list scores only the static components", () => {
    const result = computeScore([], PERFECT_COMPONENTS);
    expect(result.score).toBe(100);
    expect(result.unknown_must_have_share).toBe(0);
  });

  it("low-confidence gate: >40% must-have unknown weight → low_confidence", () => {
    // 2 of 5 must-haves unknown = exactly 0.4 → NOT low confidence (strictly greater).
    const atThreshold = computeScore(
      [
        v("must_have", "unknown"),
        v("must_have", "unknown"),
        v("must_have", "match"),
        v("must_have", "match"),
        v("must_have", "match"),
      ],
      PERFECT_COMPONENTS,
    );
    expect(atThreshold.unknown_must_have_share).toBeCloseTo(0.4, 10);
    expect(atThreshold.low_confidence).toBe(false);

    // 3 of 5 unknown = 0.6 → low confidence.
    const above = computeScore(
      [
        v("must_have", "unknown"),
        v("must_have", "unknown"),
        v("must_have", "unknown"),
        v("must_have", "match"),
        v("must_have", "match"),
      ],
      PERFECT_COMPONENTS,
    );
    expect(above.unknown_must_have_share).toBeCloseTo(0.6, 10);
    expect(above.low_confidence).toBe(true);
  });

  it("determinism: identical inputs → identical output", () => {
    const verdicts = [
      v("must_have", "match"),
      v("must_have", "partial"),
      v("must_have", "unknown"),
      v("nice_to_have", "missing"),
    ];
    const components = {
      experience: 0.6,
      industry: 1,
      location_remote: 0.5,
      languages: 0,
      education: 1,
    };
    const a = computeScore(verdicts, components);
    const b = computeScore(verdicts.map((x) => ({ ...x })), { ...components });
    expect(a).toEqual(b);
    // (0.45 × (1+0.5+0.35)/3) + 0 + 0.15×0.6 + 0.08 + 0.05×0.5 + 0 + 0.03 = 0.5025 → 50
    expect(a.score).toBe(50);
  });

  it("breakdown contributions sum to the total score", () => {
    const result = computeScore(
      [v("must_have", "partial"), v("nice_to_have", "match")],
      PERFECT_COMPONENTS,
    );
    const sum = Object.values(result.breakdown).reduce((acc, c) => acc + c.contribution, 0);
    expect(Math.round(100 * sum)).toBe(result.score);
  });
});
