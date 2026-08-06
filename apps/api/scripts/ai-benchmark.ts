import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATASET_DIR } from "./ai-benchmark/dataset.js";
import { precision, recall, ratio } from "./ai-benchmark/metrics.js";
import { renderMarkdownReport } from "./ai-benchmark/report.js";
import { runBenchmark, type BenchMode } from "./ai-benchmark/run.js";

/**
 * AI benchmark CLI (spec 003 §10, T2.6). Run via `pnpm bench:ai`.
 *
 * Env:
 * - AI_BENCH_MODE=replay|live|record (default: replay — offline, CI-safe)
 * - AI_BENCH_DATASET=<dir> (default: apps/api/test/fixtures/ai-benchmark)
 * - AI_BENCH_REPORT=<path> (default: <dataset>/reports/<templateVersion>.md)
 * - live/record use the app's provider config: LLM_BASE_URL, LLM_PROVIDER_API_KEY, LLM_MODEL.
 *
 * Exit code is 1 when a hard floor fails, so a prompt regression is visible
 * from the command line; CI gating is wired later (T6.2).
 */

const MODES: ReadonlySet<string> = new Set(["replay", "live", "record"]);

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const modeEnv = process.env.AI_BENCH_MODE ?? "replay";
  if (!MODES.has(modeEnv)) {
    throw new Error(`AI_BENCH_MODE must be one of replay|live|record, got "${modeEnv}"`);
  }
  const mode = modeEnv as BenchMode;
  const datasetDir = process.env.AI_BENCH_DATASET ?? DATASET_DIR;

  const result = await runBenchmark({ mode, datasetDir });
  const reportPath =
    process.env.AI_BENCH_REPORT ??
    path.join(datasetDir, "reports", `${result.templateVersion}.md`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderMarkdownReport(result));

  const { aggregate, pairAggregate, floors } = result;
  console.log(`ai-benchmark (${mode}) — ${result.templateVersion}, ${aggregate.fixtureCount} fixtures`);
  console.log(
    `  schema validity:      ${aggregate.schemaValidCount}/${aggregate.fixtureCount}`,
  );
  console.log(
    `  evidence-verbatim:    ${aggregate.evidenceVerified}/${aggregate.evidenceTotal} (${pct(ratio(aggregate.evidenceVerified, aggregate.evidenceTotal))})`,
  );
  console.log(
    `  precision / recall:   ${pct(precision(aggregate))} / ${pct(recall(aggregate))}`,
  );
  console.log(
    `  UNKNOWN-correctness:  ${aggregate.unknownCorrect}/${aggregate.unknownTotal} (invented: ${aggregate.inventedCount})`,
  );
  console.log(
    `  verdict accuracy:     ${pairAggregate.correct}/${pairAggregate.total} (${pct(ratio(pairAggregate.correct, pairAggregate.total))}) across ${pairAggregate.pairCount} CV×JD pairs (UNKNOWN↔MISSING confusions: ${pairAggregate.unknownMissingConfusions})`,
  );
  console.log(`  report written to ${reportPath}`);

  const floorsPass =
    floors.schemaValid && floors.evidenceVerbatim && floors.unknownRespected && floors.verdictAccuracy;
  if (!floorsPass) {
    console.error(`  HARD FLOOR FAILURE: ${JSON.stringify(floors)}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
