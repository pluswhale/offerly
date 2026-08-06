import path from "node:path";
import {
  precision,
  ratio,
  recall,
  type AggregateMetrics,
  type FixtureMetrics,
  type HardFloors,
  type PairAggregateMetrics,
  type PairMetrics,
} from "./metrics.js";
import type { BenchmarkResult } from "./run.js";

/** Markdown benchmark report (spec 003 §10, T2.6) — committed per prompt change (T6.2). */

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function floorsRow(label: string, pass: boolean): string {
  return `| ${label} | ${pass ? "PASS" : "FAIL"} |`;
}

function aggregateSection(
  aggregate: AggregateMetrics,
  pairs: PairAggregateMetrics,
  floors: HardFloors,
): string {
  const lines = [
    "## Aggregate",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Fixtures | ${aggregate.fixtureCount} |`,
    `| Schema validity | ${aggregate.schemaValidCount}/${aggregate.fixtureCount} (${pct(ratio(aggregate.schemaValidCount, aggregate.fixtureCount))}) |`,
    `| Evidence-verbatim rate | ${aggregate.evidenceVerified}/${aggregate.evidenceTotal} (${pct(ratio(aggregate.evidenceVerified, aggregate.evidenceTotal))}) |`,
    `| Stated-field precision | ${pct(precision(aggregate))} (tp=${aggregate.tp}, fp=${aggregate.fp}) |`,
    `| Stated-field recall | ${pct(recall(aggregate))} (tp=${aggregate.tp}, fn=${aggregate.fn}) |`,
    `| UNKNOWN-correctness | ${aggregate.unknownCorrect}/${aggregate.unknownTotal} (${pct(ratio(aggregate.unknownCorrect, aggregate.unknownTotal))}) |`,
    `| Invented expected-unknown fields | ${aggregate.inventedCount} |`,
    `| Verdict accuracy (${pairs.pairCount} CV×JD pairs) | ${pairs.correct}/${pairs.total} (${pct(ratio(pairs.correct, pairs.total))}) |`,
    `| UNKNOWN↔MISSING confusions | ${pairs.unknownMissingConfusions} |`,
    "",
    "## Hard floors (CI)",
    "",
    "| Floor | Result |",
    "|---|---|",
    floorsRow("100% schema validity", floors.schemaValid),
    floorsRow("100% evidence-verbatim rate on stated facts", floors.evidenceVerbatim),
    floorsRow("Zero invented expected-unknown fields", floors.unknownRespected),
    floorsRow("100% verdict accuracy on recorded CV×JD pairs", floors.verdictAccuracy),
  ];
  return lines.join("\n");
}

function fixtureRow(f: FixtureMetrics): string {
  const verbatim = f.schemaValid
    ? `${f.evidenceVerified}/${f.evidenceTotal}`
    : (f.error ?? "error");
  const adjudication =
    f.validation.items === 0
      ? "skipped (nothing flagged)"
      : (f.validation.note ?? `${f.validation.adjudicated}/${f.validation.items} adjudicated`);
  return (
    `| ${f.name} | ${f.schemaValid ? "yes" : "NO"} | ${verbatim} | ` +
    `${pct(precision(f))} | ${pct(recall(f))} | ${f.unknownCorrect}/${f.unknownTotal} | ` +
    `${f.invented.length} | ${adjudication} |`
  );
}

function pairRow(p: PairMetrics): string {
  if (!p.schemaValid) {
    return `| ${p.name} | ${p.cv} | ${p.jd} | error: ${p.error ?? "unknown"} | — | — |`;
  }
  return (
    `| ${p.name} | ${p.cv} | ${p.jd} | ` +
    `${p.correct}/${p.total} (${pct(ratio(p.correct, p.total))}) | ` +
    `${p.unresolvedCount} | ${p.unknownMissingConfusions.length} |`
  );
}

function pairSection(pairs: PairMetrics[]): string {
  if (pairs.length === 0) return "";
  return [
    "## Requirement verdicts (pre-pass + match-requirements.v1)",
    "",
    "| Pair | CV | JD | Verdict accuracy | LLM-classified | UNKNOWN↔MISSING confusions |",
    "|---|---|---|---|---|---|",
    ...pairs.map(pairRow),
  ].join("\n");
}

function failureDetails(f: FixtureMetrics): string[] {
  const lines: string[] = [];
  if (f.error !== null) lines.push(`- **${f.name}** — run failed: ${f.error}`);
  for (const failure of f.failedStated) {
    lines.push(`- **${f.name}** ${failure.path}: expected \`${failure.expected}\`, got \`${failure.actual}\``);
  }
  for (const extra of f.extras) {
    lines.push(`- **${f.name}** ${extra.path}: unexpected extra(s): ${extra.values.join(", ")}`);
  }
  for (const inv of f.invented) {
    lines.push(`- **${f.name}** ${inv.path}: expected UNKNOWN, got ${inv.actual}`);
  }
  return lines;
}

function pairFailureDetails(p: PairMetrics): string[] {
  const lines: string[] = [];
  if (p.error !== null) lines.push(`- **${p.name}** — pair run failed: ${p.error}`);
  for (const mismatch of p.mismatches) {
    const confusion = p.unknownMissingConfusions.includes(mismatch)
      ? " (UNKNOWN↔MISSING confusion)"
      : "";
    lines.push(
      `- **${p.name}** ${mismatch.requirement_id}: expected \`${mismatch.expected}\`, got \`${mismatch.actual}\`${confusion}`,
    );
  }
  return lines;
}

export function renderMarkdownReport(result: BenchmarkResult): string {
  const sections = [
    `# AI benchmark report — ${result.templateVersion}`,
    "",
    `- Generated: ${result.generatedAt}`,
    `- Mode: ${result.mode}${result.mode === "replay" ? " (recorded responses, no provider calls; token counts excluded)" : ""}`,
    `- Templates under test: ${result.templateVersion} (extraction), ${result.validationTemplateVersion} (validation, conditional), ${result.jdTemplateVersion} (JD extraction), ${result.matchTemplateVersion} (requirement verdicts)`,
    `- Dataset: ${path.relative(process.cwd(), result.datasetDir) || "."}`,
    "",
    aggregateSection(result.aggregate, result.pairAggregate, result.floors),
    "",
    "## Per fixture",
    "",
    "| Fixture | Schema valid | Evidence verbatim | Precision | Recall | UNKNOWN correct | Invented | Validation |",
    "|---|---|---|---|---|---|---|---|",
    ...result.fixtures.map(fixtureRow),
  ];

  const pairs = pairSection(result.pairs);
  if (pairs.length > 0) sections.push("", pairs);

  const details = [
    ...result.fixtures.flatMap(failureDetails),
    ...result.pairs.flatMap(pairFailureDetails),
  ];
  sections.push("", "## Failures and deviations", "");
  sections.push(details.length > 0 ? details.join("\n") : "None.");

  return `${sections.join("\n")}\n`;
}
