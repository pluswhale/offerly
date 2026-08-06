/**
 * Pure aggregation for the cost & observability report (spec 003 §10, T6.4).
 * No I/O here — the CLI (../cost-report.ts) fetches rows and passes them in,
 * so every function is unit-testable offline with fixtures.
 */

/** Row shape read from usage_records (only the columns the report needs). */
export interface UsageRow {
  user_id: string;
  operation: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_microcents: number | null;
  cache_hit: boolean | null;
}

export interface OperationTotal {
  operation: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costMicrocents: number;
  /** cache_hit=true share of calls, 0..1 (0 when no calls). */
  cacheHitRate: number;
}

export interface UserTotal {
  userId: string;
  calls: number;
  costMicrocents: number;
}

export interface StageDurationStats {
  stage: string;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** 1 microcent = 1e-6 of a US cent → 1 USD = 1e8 microcents. */
export function microcentsToUsd(microcents: number): number {
  return microcents / 1e8;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Per-operation totals, sorted by cost descending. */
export function aggregateByOperation(rows: UsageRow[]): OperationTotal[] {
  const byOp = new Map<string, OperationTotal>();
  for (const row of rows) {
    let total = byOp.get(row.operation);
    if (!total) {
      total = {
        operation: row.operation,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costMicrocents: 0,
        cacheHitRate: 0,
      };
      byOp.set(row.operation, total);
    }
    total.calls += 1;
    total.tokensIn += row.tokens_in ?? 0;
    total.tokensOut += row.tokens_out ?? 0;
    total.costMicrocents += row.cost_microcents ?? 0;
    if (row.cache_hit) total.cacheHitRate += 1;
  }
  const totals = [...byOp.values()];
  for (const total of totals) {
    total.cacheHitRate = total.calls > 0 ? total.cacheHitRate / total.calls : 0;
  }
  return totals.sort((a, b) => b.costMicrocents - a.costMicrocents);
}

/** Top users by total spend, descending. */
export function topUsersByCost(rows: UsageRow[], limit = 10): UserTotal[] {
  const byUser = new Map<string, UserTotal>();
  for (const row of rows) {
    let total = byUser.get(row.user_id);
    if (!total) {
      total = { userId: row.user_id, calls: 0, costMicrocents: 0 };
      byUser.set(row.user_id, total);
    }
    total.calls += 1;
    total.costMicrocents += row.cost_microcents ?? 0;
  }
  return [...byUser.values()]
    .sort((a, b) => b.costMicrocents - a.costMicrocents)
    .slice(0, limit);
}

/** Nearest-rank percentile; null for empty input. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[index] ?? null;
}

/**
 * p50/p95 durations per pipeline stage from candidate_profiles.stage_meta
 * rows (shape: `{ stages: { s1?: { duration_ms }, s2?, s3? } }`, see
 * ProfileStageMeta). Rows with malformed meta are skipped, not fatal.
 */
export function stageDurationStats(stageMetaRows: unknown[]): StageDurationStats[] {
  const durations = new Map<string, number[]>();
  for (const row of stageMetaRows) {
    const stages = (row as { stages?: Record<string, { duration_ms?: unknown }> | null } | null)
      ?.stages;
    if (!stages || typeof stages !== "object") continue;
    for (const [stage, timing] of Object.entries(stages)) {
      const ms = timing?.duration_ms;
      if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
      const list = durations.get(stage);
      if (list) list.push(ms);
      else durations.set(stage, [ms]);
    }
  }
  return [...durations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        stage,
        samples: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      };
    });
}

export interface CostReportInput {
  /** e.g. "2026-07" */
  month: string;
  operations: OperationTotal[];
  topUsers: UserTotal[];
  stages: StageDurationStats[];
  /** Distinct users with at least one usage row in the month. */
  activeUsers: number;
  totalCostMicrocents: number;
  proPriceUsd: number;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number | null): string {
  return ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`;
}

/** Render the Markdown report printed by the CLI. */
export function renderCostReport(input: CostReportInput): string {
  const lines: string[] = [];
  lines.push(`# AI Cost Report — ${input.month}`);
  lines.push("");
  lines.push("## Per-operation totals");
  lines.push("");
  lines.push("| Operation | Calls | Cache-hit | Tokens in | Tokens out | Cost |");
  lines.push("|---|---|---|---|---|---|");
  for (const op of input.operations) {
    lines.push(
      `| ${op.operation} | ${op.calls} | ${formatPct(op.cacheHitRate)} | ${op.tokensIn} | ${op.tokensOut} | ${formatUsd(microcentsToUsd(op.costMicrocents))} |`,
    );
  }
  lines.push(
    `| **total** | ${input.operations.reduce((s, o) => s + o.calls, 0)} | — | ${input.operations.reduce((s, o) => s + o.tokensIn, 0)} | ${input.operations.reduce((s, o) => s + o.tokensOut, 0)} | **${formatUsd(microcentsToUsd(input.totalCostMicrocents))}** |`,
  );
  lines.push("");
  lines.push(`## Top ${input.topUsers.length} users by cost`);
  lines.push("");
  lines.push("| User | Calls | Cost |");
  lines.push("|---|---|---|");
  for (const user of input.topUsers) {
    lines.push(
      `| ${user.userId} | ${user.calls} | ${formatUsd(microcentsToUsd(user.costMicrocents))} |`,
    );
  }
  lines.push("");
  lines.push("## Pipeline stage durations (candidate_profiles.stage_meta)");
  lines.push("");
  lines.push("| Stage | Samples | p50 | p95 |");
  lines.push("|---|---|---|---|");
  for (const stage of input.stages) {
    lines.push(
      `| ${stage.stage} | ${stage.samples} | ${formatMs(stage.p50Ms)} | ${formatMs(stage.p95Ms)} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  const perUserUsd =
    input.activeUsers > 0 ? microcentsToUsd(input.totalCostMicrocents) / input.activeUsers : 0;
  const verdict =
    input.activeUsers === 0
      ? "no usage this month"
      : perUserUsd <= input.proPriceUsd
        ? "OK — spend below Pro revenue"
        : "WARNING — spend exceeds Pro revenue (constitution §V)";
  lines.push(
    `AI spend per active user: ${formatUsd(perUserUsd)} vs Pro price ${formatUsd(input.proPriceUsd)} — ${verdict}`,
  );
  lines.push(`(${input.activeUsers} active users this month)`);
  lines.push("");
  return lines.join("\n");
}
