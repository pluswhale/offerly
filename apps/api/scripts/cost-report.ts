import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateByOperation,
  renderCostReport,
  stageDurationStats,
  topUsersByCost,
  type UsageRow,
} from "./cost-report/aggregate.js";

/**
 * Cost & observability report (spec 003 §10, T6.4). Run via `pnpm report:cost`.
 * Prints a Markdown report for the current UTC month: per-operation
 * tokens/cost/cache-hit rates from usage_records, top-10 users by cost,
 * p50/p95 pipeline stage durations from candidate_profiles.stage_meta, and
 * the constitution §V verdict (AI spend per active user vs Pro price).
 *
 * Env (same as the API — load apps/api/.env first, see RUNNING_LOCALLY.md):
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read-only queries; service role
 *   is needed to aggregate across users).
 *
 * Operator script, run manually — exits non-zero with a clear message when
 * env or DB is unreachable.
 */

// TODO(spec 001 plans): no plan price is modeled in code today (only
// STRIPE_PRICE_ID env). Keep in sync with the Stripe Pro plan price.
const PRO_PRICE_USD = 9;

const PAGE_SIZE = 1000;

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  table: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`cost-report: failed to read ${table}: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "cost-report: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required " +
        "(load apps/api/.env first: `cd apps/api && set -a && source .env && set +a`)",
    );
  }

  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = monthStart.toISOString().slice(0, 7);

  const usageRows = await fetchAllPages(
    (from, to) =>
      client
        .from("usage_records")
        .select("user_id, operation, tokens_in, tokens_out, cost_microcents, cache_hit")
        .gte("created_at", monthStart.toISOString())
        .range(from, to),
    "usage_records",
  ) as unknown as UsageRow[];

  const stageMetaRows = (await fetchAllPages(
    (from, to) =>
      client
        .from("candidate_profiles")
        .select("stage_meta")
        .gte("created_at", monthStart.toISOString())
        .range(from, to),
    "candidate_profiles",
  )) as unknown as Array<{ stage_meta: unknown }>;

  const operations = aggregateByOperation(usageRows);
  const report = renderCostReport({
    month,
    operations,
    topUsers: topUsersByCost(usageRows, 10),
    stages: stageDurationStats(stageMetaRows.map((row) => row.stage_meta)),
    activeUsers: new Set(usageRows.map((row) => row.user_id)).size,
    totalCostMicrocents: operations.reduce((sum, op) => sum + op.costMicrocents, 0),
    proPriceUsd: PRO_PRICE_USD,
  });

  console.log(report);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
