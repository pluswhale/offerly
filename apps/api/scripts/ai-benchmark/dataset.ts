import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { verdictValueSchema } from "../../src/modules/ai/schemas/match-report.schema.js";

/**
 * Benchmark dataset access (spec 003 §10, T2.6). The dataset lives in
 * `apps/api/test/fixtures/ai-benchmark/`:
 * - `cvs/<name>.cv.txt` + `cvs/<name>.expected.json` — anonymized CVs with
 *   human-labeled expectations (fields that MUST be extracted, fields that
 *   MUST stay unknown).
 * - `jds/<name>.jd.txt` + `jds/<name>.expected.json` — JD texts with expected
 *   required skills (data only until the Phase 3 jd-extract benchmark).
 * - `pairs/<cv>--<jd>.verdicts.expected.json` — human-labeled expected
 *   requirement verdicts per CV×JD pair (T3.3 match-requirements benchmark).
 * - `recorded/<name>.<templateVersion>.json` — recorded provider responses
 *   for offline replay (CI) and regression comparison.
 */

/**
 * Default dataset location (apps/api/test/fixtures/ai-benchmark). Resolved
 * from the cwd because the api package compiles to CommonJS (no import.meta):
 * both supported invocations — `pnpm bench:ai` (repo root or apps/api) and
 * `vitest run` (apps/api) — match one of these candidates. AI_BENCH_DATASET
 * overrides it.
 */
const DATASET_DIR_CANDIDATES = [
  path.resolve(process.cwd(), "test/fixtures/ai-benchmark"),
  path.resolve(process.cwd(), "apps/api/test/fixtures/ai-benchmark"),
];
export const DATASET_DIR =
  DATASET_DIR_CANDIDATES.find((candidate) => existsSync(candidate)) ??
  DATASET_DIR_CANDIDATES[0] ??
  path.resolve("test/fixtures/ai-benchmark");

const scalarExpectationSchema = z.union([z.string(), z.number(), z.boolean()]);

export const cvExpectationSchema = z.object({
  description: z.string().optional(),
  /**
   * Fields that MUST be extracted. Scalar paths (e.g. "headline.title") map to
   * the expected value; array paths (skill groups, "languages", …) map to the
   * expected member values — members are also used as the precision baseline.
   */
  stated: z.record(z.string(), z.union([scalarExpectationSchema, z.array(z.string())])),
  /** Paths that MUST remain unknown: scalar leaves with status 'unknown', or empty arrays. */
  unknown: z.array(z.string()),
});

export type CvExpectation = z.infer<typeof cvExpectationSchema>;

export interface CvFixture {
  name: string;
  cvText: string;
  /** Stable cache identity for the fixture (recordings are keyed by name). */
  contentHash: string;
  expected: CvExpectation;
}

export async function loadCvFixtures(datasetDir: string = DATASET_DIR): Promise<CvFixture[]> {
  const cvsDir = path.join(datasetDir, "cvs");
  const names = (await readdir(cvsDir))
    .filter((entry) => entry.endsWith(".cv.txt"))
    .map((entry) => entry.slice(0, -".cv.txt".length))
    .sort();
  const fixtures: CvFixture[] = [];
  for (const name of names) {
    const cvText = await readFile(path.join(cvsDir, `${name}.cv.txt`), "utf8");
    const raw: unknown = JSON.parse(
      await readFile(path.join(cvsDir, `${name}.expected.json`), "utf8"),
    );
    fixtures.push({
      name,
      cvText,
      contentHash: `ai-benchmark:${name}`,
      expected: cvExpectationSchema.parse(raw),
    });
  }
  return fixtures;
}

export const jdExpectationSchema = z.object({
  description: z.string().optional(),
  expected: z.object({
    required_skills: z.array(z.string()),
    preferred_skills: z.array(z.string()),
    min_years_experience: z.number().nullable(),
    remote_policy: z.string().nullable(),
    languages: z.array(z.string()),
    industry: z.string().nullable(),
  }),
});

export type JdExpectation = z.infer<typeof jdExpectationSchema>;

export interface JdFixture {
  name: string;
  jdText: string;
  expectation: JdExpectation;
}

/** JD fixtures are data-only until Phase 3 wires the jd-extract benchmark. */
export async function loadJdFixtures(datasetDir: string = DATASET_DIR): Promise<JdFixture[]> {
  const jdsDir = path.join(datasetDir, "jds");
  const names = (await readdir(jdsDir))
    .filter((entry) => entry.endsWith(".jd.txt"))
    .map((entry) => entry.slice(0, -".jd.txt".length))
    .sort();
  const fixtures: JdFixture[] = [];
  for (const name of names) {
    const jdText = await readFile(path.join(jdsDir, `${name}.jd.txt`), "utf8");
    const raw: unknown = JSON.parse(
      await readFile(path.join(jdsDir, `${name}.expected.json`), "utf8"),
    );
    fixtures.push({ name, jdText, expectation: jdExpectationSchema.parse(raw) });
  }
  return fixtures;
}

/* ---------------- CV×JD verdict pairs (T3.3) ---------------- */

export const PAIR_SUFFIX = ".verdicts.expected.json";

export const pairExpectationSchema = z.object({
  description: z.string().optional(),
  /** Fixture names (without extensions) of the CV and JD being matched. */
  cv: z.string().min(1),
  jd: z.string().min(1),
  /**
   * Human-labeled expected verdict per requirement id — covers ALL of the
   * JD's requirements (pre-pass-resolved and LLM-classified alike), so the
   * accuracy metric scores the whole classification step (spec §FR-7).
   */
  expected_verdicts: z.record(z.string(), verdictValueSchema),
});

export type PairExpectation = z.infer<typeof pairExpectationSchema>;

export interface PairFixture {
  /**
   * Pair name, e.g. "senior-multirole--senior-backend-fintech". The "--"
   * separator keeps the recorded/ prefix (`<name>.`) from colliding with the
   * CV fixture of the same base name.
   */
  name: string;
  cv: string;
  jd: string;
  expectedVerdicts: PairExpectation["expected_verdicts"];
}

/** CV×JD verdict expectations live in `pairs/<cv>--<jd>.verdicts.expected.json`. */
export async function loadPairFixtures(datasetDir: string = DATASET_DIR): Promise<PairFixture[]> {
  const pairsDir = path.join(datasetDir, "pairs");
  const entries = await readdir(pairsDir).catch(() => [] as string[]);
  const fixtures: PairFixture[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(PAIR_SUFFIX)) continue;
    const raw: unknown = JSON.parse(await readFile(path.join(pairsDir, entry), "utf8"));
    const parsed = pairExpectationSchema.parse(raw);
    fixtures.push({
      name: entry.slice(0, -PAIR_SUFFIX.length),
      cv: parsed.cv,
      jd: parsed.jd,
      expectedVerdicts: parsed.expected_verdicts,
    });
  }
  return fixtures;
}

/**
 * Recorded provider responses for one fixture: templateVersion → raw response
 * body (a JSON string of the template's output). Missing directory/file is
 * fine — the caller decides whether that is an error (replay) or irrelevant
 * (live/record).
 */
export async function loadRecordings(
  datasetDir: string,
  fixtureName: string,
): Promise<Map<string, string>> {
  const dir = path.join(datasetDir, "recorded");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const recordings = new Map<string, string>();
  const prefix = `${fixtureName}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const templateVersion = entry.slice(prefix.length, -".json".length);
    recordings.set(templateVersion, await readFile(path.join(dir, entry), "utf8"));
  }
  return recordings;
}

/** Persist a recorded response; pretty-printed when it parses as JSON. */
export async function saveRecording(
  datasetDir: string,
  fixtureName: string,
  templateVersion: string,
  content: string,
): Promise<void> {
  let out = content;
  try {
    out = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  } catch {
    // Not parseable — store the raw body; the run will report it as schema-invalid.
  }
  await writeFile(path.join(datasetDir, "recorded", `${fixtureName}.${templateVersion}.json`), out);
}
