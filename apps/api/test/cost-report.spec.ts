import { describe, expect, it } from "vitest";
import {
  aggregateByOperation,
  formatUsd,
  microcentsToUsd,
  percentile,
  renderCostReport,
  stageDurationStats,
  topUsersByCost,
  type UsageRow,
} from "../scripts/cost-report/aggregate.js";

/** Offline tests for the T6.4 cost report rollups (spec 003 §10). */

function row(partial: Partial<UsageRow> & { user_id: string; operation: string }): UsageRow {
  return {
    tokens_in: 0,
    tokens_out: 0,
    cost_microcents: 0,
    cache_hit: false,
    ...partial,
  };
}

describe("aggregateByOperation (T6.4)", () => {
  it("rolls up calls, tokens, cost and cache-hit rate per operation", () => {
    const rows: UsageRow[] = [
      row({ user_id: "u1", operation: "cv_profile", tokens_in: 1000, tokens_out: 500, cost_microcents: 45_000 }),
      row({ user_id: "u1", operation: "cv_profile", tokens_in: 0, tokens_out: 0, cost_microcents: 0, cache_hit: true }),
      row({ user_id: "u2", operation: "job_match", tokens_in: 200, tokens_out: 100, cost_microcents: 9_000 }),
      row({ user_id: "u2", operation: "job_match", tokens_in: null, tokens_out: null, cost_microcents: null, cache_hit: null }),
    ];
    const totals = aggregateByOperation(rows);

    // Sorted by cost descending.
    expect(totals.map((t) => t.operation)).toEqual(["cv_profile", "job_match"]);

    const cvProfile = totals[0];
    expect(cvProfile).toMatchObject({
      calls: 2,
      tokensIn: 1000,
      tokensOut: 500,
      costMicrocents: 45_000,
    });
    expect(cvProfile?.cacheHitRate).toBeCloseTo(0.5);

    const jobMatch = totals[1];
    // null columns are treated as zero, not skipped.
    expect(jobMatch).toMatchObject({ calls: 2, tokensIn: 200, tokensOut: 100, costMicrocents: 9_000 });
    expect(jobMatch?.cacheHitRate).toBe(0);
  });

  it("returns an empty list for no rows", () => {
    expect(aggregateByOperation([])).toEqual([]);
  });
});

describe("topUsersByCost (T6.4)", () => {
  it("sums per user, sorts by cost descending, and caps at the limit", () => {
    const rows: UsageRow[] = [];
    for (let i = 1; i <= 12; i++) {
      rows.push(row({ user_id: `u${i}`, operation: "coach_message", cost_microcents: i * 1_000 }));
      rows.push(row({ user_id: `u${i}`, operation: "cv_analysis", cost_microcents: i * 1_000 }));
    }
    const top = topUsersByCost(rows, 10);
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ userId: "u12", calls: 2, costMicrocents: 24_000 });
    expect(top[9]).toEqual({ userId: "u3", calls: 2, costMicrocents: 6_000 });
  });
});

describe("percentile (T6.4)", () => {
  it("nearest-rank p50/p95", () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(sorted, 0.5)).toBe(500);
    expect(percentile(sorted, 0.95)).toBe(1000);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("null for empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("stageDurationStats (T6.4)", () => {
  it("collects per-stage durations from stage_meta and computes p50/p95", () => {
    const metas = [
      { stages: { s1: { duration_ms: 10_000 }, s2: { duration_ms: 50 }, s3: { duration_ms: 4000 } } },
      { stages: { s1: { duration_ms: 12_000 }, s2: { duration_ms: 70 } } },
      { stages: { s1: { duration_ms: 8_000 }, s3: { duration_ms: 6000, skipped: false } } },
      { stages: { s3: { skipped: true } } }, // no duration → skipped
      null,
      { stages: null },
      "garbage",
    ];
    const stats = stageDurationStats(metas);
    const byStage = new Map(stats.map((s) => [s.stage, s]));

    expect(byStage.get("s1")).toEqual({ stage: "s1", samples: 3, p50Ms: 10_000, p95Ms: 12_000 });
    expect(byStage.get("s2")).toEqual({ stage: "s2", samples: 2, p50Ms: 50, p95Ms: 70 });
    expect(byStage.get("s3")).toEqual({ stage: "s3", samples: 2, p50Ms: 4000, p95Ms: 6000 });
  });

  it("returns an empty list when nothing has durations", () => {
    expect(stageDurationStats([null, { stages: {} }])).toEqual([]);
  });
});

describe("renderCostReport (T6.4)", () => {
  const baseInput = {
    month: "2026-07",
    operations: aggregateByOperation([
      row({ user_id: "u1", operation: "cv_profile", tokens_in: 1000, tokens_out: 500, cost_microcents: 45_000 }),
      row({ user_id: "u2", operation: "job_match", cost_microcents: 5_000 }),
    ]),
    topUsers: topUsersByCost([
      row({ user_id: "u1", operation: "cv_profile", cost_microcents: 45_000 }),
      row({ user_id: "u2", operation: "job_match", cost_microcents: 5_000 }),
    ]),
    stages: stageDurationStats([{ stages: { s1: { duration_ms: 10_000 } } }]),
    activeUsers: 2,
    totalCostMicrocents: 50_000, // $0.0005
    proPriceUsd: 9,
  };

  it("renders all sections with the verdict line", () => {
    const md = renderCostReport(baseInput);
    expect(md).toContain("# AI Cost Report — 2026-07");
    expect(md).toContain("| cv_profile | 1 | 0.0% | 1000 | 500 | $0.00 |");
    expect(md).toContain("| u1 | 1 | $0.00 |");
    expect(md).toContain("| s1 | 1 | 10.0s | 10.0s |");
    expect(md).toContain("AI spend per active user: $0.00 vs Pro price $9.00 — OK — spend below Pro revenue");
    expect(md).toContain("(2 active users this month)");
  });

  it("flags spend above the Pro price", () => {
    const md = renderCostReport({
      ...baseInput,
      activeUsers: 1,
      totalCostMicrocents: 1_000_000_000, // $10.00
    });
    expect(md).toContain(
      "AI spend per active user: $10.00 vs Pro price $9.00 — WARNING — spend exceeds Pro revenue (constitution §V)",
    );
  });

  it("handles a month with no usage", () => {
    const md = renderCostReport({
      ...baseInput,
      operations: [],
      topUsers: [],
      stages: [],
      activeUsers: 0,
      totalCostMicrocents: 0,
    });
    expect(md).toContain("AI spend per active user: $0.00 vs Pro price $9.00 — no usage this month");
  });
});

describe("money conversion (T6.4)", () => {
  it("1e8 microcents = $1", () => {
    expect(microcentsToUsd(1e8)).toBe(1);
    expect(formatUsd(microcentsToUsd(45_000))).toBe("$0.00");
    expect(formatUsd(microcentsToUsd(1_500_000_000))).toBe("$15.00");
  });
});
