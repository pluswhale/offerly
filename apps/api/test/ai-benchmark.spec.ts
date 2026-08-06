import { describe, expect, it } from "vitest";
import { DATASET_DIR, loadCvFixtures, loadJdFixtures } from "../scripts/ai-benchmark/dataset.js";
import { ratio } from "../scripts/ai-benchmark/metrics.js";
import { renderMarkdownReport } from "../scripts/ai-benchmark/report.js";
import { runBenchmark } from "../scripts/ai-benchmark/run.js";

/**
 * Offline AI benchmark gates (spec 003 §10, T2.6): the benchmark replays
 * recorded provider responses — no network, no API key — and the spec
 * invariants hold as hard floors:
 * - 100% schema validity of extraction output
 * - 100% evidence-verbatim rate on stated facts (spec AC-1)
 * - zero invented expected-unknown fields (spec AC-2)
 */

describe("ai-benchmark dataset (T2.6)", () => {
  it("covers the required CV categories, each with stated + unknown expectations", async () => {
    const fixtures = await loadCvFixtures();
    const names = fixtures.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "sparse-junior",
        "senior-multirole",
        "non-english-russian",
        "keyword-stuffed",
      ]),
    );
    for (const fixture of fixtures) {
      expect(Object.keys(fixture.expected.stated).length).toBeGreaterThan(0);
      expect(fixture.expected.unknown.length).toBeGreaterThan(0);
      expect(fixture.cvText.length).toBeGreaterThan(0);
    }
  });

  it("ships JD fixtures with expected required skills for the Phase 3 benchmarks", async () => {
    const jds = await loadJdFixtures();
    expect(jds.length).toBeGreaterThanOrEqual(2);
    const byName = new Map(jds.map((jd) => [jd.name, jd]));
    expect(
      byName.get("senior-backend-fintech")?.expectation.expected.required_skills,
    ).toContain("PostgreSQL");
    expect(
      byName.get("vague-rockstar")?.expectation.expected.required_skills,
    ).toEqual([]);
  });
});

describe("ai-benchmark replay mode (offline, CI floors)", () => {
  it("meets the hard floors on recorded responses", async () => {
    const result = await runBenchmark({ mode: "replay", datasetDir: DATASET_DIR });
    expect(result.fixtures.length).toBeGreaterThanOrEqual(4);

    // 100% schema validity.
    for (const fixture of result.fixtures) {
      expect(fixture.schemaValid, `${fixture.name}: ${fixture.error ?? ""}`).toBe(true);
    }
    // 100% evidence-verbatim rate on stated facts (spec AC-1).
    expect(result.aggregate.evidenceTotal).toBeGreaterThan(0);
    expect(result.aggregate.evidenceVerified).toBe(result.aggregate.evidenceTotal);
    // Zero invented expected-unknown fields (spec AC-2).
    expect(result.aggregate.inventedCount).toBe(0);

    expect(result.floors).toEqual({
      schemaValid: true,
      evidenceVerbatim: true,
      unknownRespected: true,
      verdictAccuracy: true,
    });
  });

  it("scores requirement verdicts per CV×JD pair at 100% accuracy (T3.3)", async () => {
    const result = await runBenchmark({ mode: "replay", datasetDir: DATASET_DIR });
    // 2 JDs × 2 CVs are wired.
    expect(result.pairs.length).toBeGreaterThanOrEqual(4);

    const byName = new Map(result.pairs.map((p) => [p.name, p]));

    const senior = byName.get("senior-multirole--senior-backend-fintech");
    expect(senior?.schemaValid).toBe(true);
    expect(senior?.total).toBe(9);
    expect(senior?.correct).toBe(9);
    // The pre-pass resolves 6/9; the LLM classifies the fuzzy remainder.
    expect(senior?.unresolvedCount).toBe(3);
    expect(senior?.mismatches).toEqual([]);

    const junior = byName.get("sparse-junior--senior-backend-fintech");
    expect(junior?.schemaValid).toBe(true);
    expect(junior?.correct).toBe(junior?.total);

    // The vague JD states zero requirements — nothing to classify, no LLM call.
    const vague = byName.get("senior-multirole--vague-rockstar");
    expect(vague?.schemaValid).toBe(true);
    expect(vague?.total).toBe(0);
    expect(vague?.unresolvedCount).toBe(0);

    // Recordings encode the labels: 100% accuracy, zero UNKNOWN↔MISSING confusions.
    expect(result.pairAggregate.correct).toBe(result.pairAggregate.total);
    expect(result.pairAggregate.unknownMissingConfusions).toBe(0);
    expect(result.floors.verdictAccuracy).toBe(true);
  });

  it("a degraded verdict response flips the accuracy floor and surfaces UNKNOWN↔MISSING confusions", async () => {
    // Simulate a regressed prompt: silence misclassified as absence (the
    // load-bearing spec §FR-7 distinction) on the sparse-junior pair.
    const degraded = await runBenchmark({
      mode: "replay",
      datasetDir: DATASET_DIR,
      transformRecorded: (fixtureName, templateVersion, content) => {
        if (
          fixtureName !== "sparse-junior--senior-backend-fintech" ||
          templateVersion !== "match-requirements.v1"
        ) {
          return content;
        }
        const parsed = JSON.parse(content) as {
          verdicts: Array<{
            requirement_id: string;
            verdict: string;
            candidate_evidence: string[];
          }>;
        };
        for (const verdict of parsed.verdicts) {
          if (verdict.requirement_id === "req-3") {
            verdict.verdict = "missing";
            // Structurally valid (the path exists) but semantically wrong —
            // the profile is silent on databases, so this must stay unknown.
            verdict.candidate_evidence = ["skills.programming_languages[0]"];
          }
        }
        return JSON.stringify(parsed);
      },
    });

    const junior = degraded.pairs.find((p) => p.name === "sparse-junior--senior-backend-fintech");
    expect(junior?.correct).toBe((junior?.total ?? 0) - 1);
    expect(junior?.unknownMissingConfusions).toEqual([
      { requirement_id: "req-3", expected: "unknown", actual: "missing" },
    ]);
    expect(degraded.pairAggregate.unknownMissingConfusions).toBe(1);
    expect(degraded.floors.verdictAccuracy).toBe(false);
    // Extraction floors are untouched by a verdict-only regression.
    expect(degraded.floors.evidenceVerbatim).toBe(true);
  });

  it("the no-database CV yields databases: [] and no invented skills (spec AC-2)", async () => {
    const result = await runBenchmark({ mode: "replay", datasetDir: DATASET_DIR });
    const junior = result.fixtures.find((f) => f.name === "sparse-junior");
    expect(junior).toBeDefined();
    expect(junior?.invented).toEqual([]);
    expect(junior?.unknownCorrect).toBe(junior?.unknownTotal);
  });

  it("renders a Markdown report with the aggregate and per-fixture sections", async () => {
    const result = await runBenchmark({ mode: "replay", datasetDir: DATASET_DIR });
    const report = renderMarkdownReport(result);
    expect(report).toContain("# AI benchmark report — cv-extract.v1");
    expect(report).toContain("## Aggregate");
    expect(report).toContain("## Per fixture");
    expect(report).toContain("100% evidence-verbatim rate on stated facts | PASS");
  });

  it("a deliberately degraded response visibly lowers the metrics (T2.6 gate)", async () => {
    // Simulate a regressed prompt: an invented database skill whose evidence
    // quote is not in the CV. Both the verbatim rate and UNKNOWN-correctness
    // must drop, and the floors must flip to FAIL.
    const degraded = await runBenchmark({
      mode: "replay",
      datasetDir: DATASET_DIR,
      transformRecorded: (fixtureName, _templateVersion, content) => {
        if (fixtureName !== "sparse-junior") return content;
        const parsed = JSON.parse(content) as {
          skills: { databases: unknown[] };
        };
        parsed.skills.databases.push({
          value: "PostgreSQL",
          status: "stated",
          confidence: 0.95,
          evidence: "managed PostgreSQL clusters in production",
        });
        return JSON.stringify(parsed);
      },
    });

    const baseline = await runBenchmark({ mode: "replay", datasetDir: DATASET_DIR });
    expect(ratio(degraded.aggregate.evidenceVerified, degraded.aggregate.evidenceTotal)).toBeLessThan(
      ratio(baseline.aggregate.evidenceVerified, baseline.aggregate.evidenceTotal) ?? 0,
    );
    expect(degraded.aggregate.inventedCount).toBeGreaterThan(0);
    expect(degraded.floors.evidenceVerbatim).toBe(false);
    expect(degraded.floors.unknownRespected).toBe(false);

    const junior = degraded.fixtures.find((f) => f.name === "sparse-junior");
    expect(junior?.invented.map((i) => i.path)).toContain("skills.databases");
  });
});
