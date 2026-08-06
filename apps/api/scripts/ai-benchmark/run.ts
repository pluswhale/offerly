import { env } from "../../src/common/env.js";
import { AiService } from "../../src/modules/ai/ai.service.js";
import { verifyCandidateProfileEvidence } from "../../src/modules/ai/evidence.js";
import { extractJobProfile } from "../../src/modules/ai/job-extraction.js";
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
} from "../../src/modules/ai/llm-provider.js";
import { matchRequirements } from "../../src/modules/ai/matching/match-requirements.js";
import { resolveBatch } from "../../src/modules/ai/matching/prepass.js";
import { OpenAiCompatibleProvider } from "../../src/modules/ai/openai-compatible.provider.js";
import { extractCandidateProfile } from "../../src/modules/ai/profile-extraction.js";
import {
  collectValidationItems,
  runValidation,
} from "../../src/modules/ai/profile-validation.js";
import { cvExtractV1 } from "../../src/modules/ai/prompts/cv-extract.v1.js";
import { cvValidateV1 } from "../../src/modules/ai/prompts/cv-validate.v1.js";
import { jdExtractV1 } from "../../src/modules/ai/prompts/jd-extract.v1.js";
import {
  MATCH_REQUIREMENTS_TEMPLATE_VERSION,
  matchRequirementsSystemPrompt,
} from "../../src/modules/ai/prompts/match-requirements.v1.js";
import type { SupabaseService } from "../../src/modules/supabase/supabase.service.js";
import {
  DATASET_DIR,
  loadCvFixtures,
  loadJdFixtures,
  loadPairFixtures,
  loadRecordings,
  saveRecording,
  type CvFixture,
  type JdFixture,
  type PairFixture,
} from "./dataset.js";
import {
  aggregateMetrics,
  aggregatePairMetrics,
  checkHardFloors,
  computeFixtureMetrics,
  computePairMetrics,
  failedFixtureMetrics,
  failedPairMetrics,
  type AggregateMetrics,
  type FixtureMetrics,
  type HardFloors,
  type PairAggregateMetrics,
  type PairMetrics,
} from "./metrics.js";

/**
 * Benchmark runner (spec 003 §10, T2.6): runs S1+S2 (and S3 when items are
 * flagged) for every CV fixture through the real AiService gateway, either
 * - `replay`: against recorded provider responses (offline, CI-safe),
 * - `live`: against the configured provider (LLM_BASE_URL/LLM_PROVIDER_API_KEY),
 * - `record`: live, persisting responses to `recorded/` for future replays.
 */

export type BenchMode = "replay" | "live" | "record";

export interface BenchmarkOptions {
  mode: BenchMode;
  datasetDir?: string;
  /**
   * Test hook: rewrite a recorded response before replay — used to prove a
   * degraded prompt visibly lowers the metrics (T2.6 acceptance).
   */
  transformRecorded?: (fixtureName: string, templateVersion: string, content: string) => string;
}

export interface BenchmarkResult {
  mode: BenchMode;
  datasetDir: string;
  templateVersion: string;
  validationTemplateVersion: string;
  jdTemplateVersion: string;
  matchTemplateVersion: string;
  fixtures: FixtureMetrics[];
  aggregate: AggregateMetrics;
  pairs: PairMetrics[];
  pairAggregate: PairAggregateMetrics;
  floors: HardFloors;
  generatedAt: string;
}

/** System prompt → templateVersion, so a provider can route a request to its recording. */
function systemPromptIndex(): Map<string, string> {
  return new Map([
    [
      cvExtractV1.buildSystemPrompt({ cvText: "", contentHash: "", truncated: false }),
      cvExtractV1.templateVersion,
    ],
    [cvValidateV1.buildSystemPrompt({ items: [] }), cvValidateV1.templateVersion],
    [
      jdExtractV1.buildSystemPrompt({ jdText: "", contentHash: "", truncated: false }),
      jdExtractV1.templateVersion,
    ],
    [matchRequirementsSystemPrompt(), MATCH_REQUIREMENTS_TEMPLATE_VERSION],
  ]);
}

/** Offline provider: serves recorded responses, matched by the request's system prompt. */
function makeReplayProvider(recordings: Map<string, string>): LlmProvider {
  const bySystemPrompt = new Map<string, string>();
  for (const [systemPrompt, templateVersion] of systemPromptIndex()) {
    const content = recordings.get(templateVersion);
    if (content !== undefined) bySystemPrompt.set(systemPrompt, content);
  }
  return {
    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      const content = bySystemPrompt.get(request.messages[0]?.content ?? "");
      if (content === undefined) {
        throw new Error(
          "ai-benchmark: no recorded response for this prompt — re-record with AI_BENCH_MODE=record",
        );
      }
      // Recordings carry no token accounting; usage/cost metrics are live-mode only.
      return { content, tokensIn: 0, tokensOut: 0 };
    },
    stream: async function* (): AsyncIterable<string> {
      throw new Error("ai-benchmark: streaming is not used by the benchmark");
    },
  };
}

/** Live provider: the same OpenAI-compatible client and env config the app uses. */
function makeLiveProvider(): LlmProvider {
  return new OpenAiCompatibleProvider({
    apiKey: env("LLM_PROVIDER_API_KEY", ""),
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1"),
  });
}

/** Wraps the live provider and captures each response body (keyed by system prompt). */
function makeRecordingProvider(inner: LlmProvider, captured: Map<string, string>): LlmProvider {
  return {
    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      const result = await inner.complete(request);
      const systemPrompt = request.messages[0]?.content;
      if (systemPrompt !== undefined) captured.set(systemPrompt, result.content);
      return result;
    },
    stream: (request: CompletionRequest) => inner.stream(request),
  };
}

/**
 * In-memory llm_cache/usage_records — the same stub shape as the unit tests.
 * The benchmark goes through the real gateway (retry, cache keys, usage
 * logging) without touching a database.
 */
function makeSupabaseStub(): SupabaseService {
  const cache = new Map<string, unknown>();
  const client = {
    from(table: string) {
      if (table === "llm_cache") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({
                data: cache.has(key) ? { response: cache.get(key) } : null,
                error: null,
              }),
            }),
          }),
          upsert: async (row: { cache_key: string; response: unknown }) => {
            cache.set(row.cache_key, row.response);
            return { error: null };
          },
        };
      }
      if (table === "usage_records") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`ai-benchmark: unexpected table: ${table}`);
    },
  };
  return { getServiceClient: () => client } as unknown as SupabaseService;
}

async function saveCaptured(
  datasetDir: string,
  fixtureName: string,
  captured: Map<string, string>,
): Promise<void> {
  const index = systemPromptIndex();
  for (const [systemPrompt, content] of captured) {
    const templateVersion = index.get(systemPrompt);
    if (templateVersion !== undefined) {
      await saveRecording(datasetDir, fixtureName, templateVersion, content);
    }
  }
}

async function runFixture(
  fixture: CvFixture,
  options: BenchmarkOptions,
  datasetDir: string,
): Promise<FixtureMetrics> {
  const recordings =
    options.mode === "replay"
      ? await loadRecordings(datasetDir, fixture.name)
      : new Map<string, string>();
  if (options.transformRecorded) {
    for (const [templateVersion, content] of recordings) {
      recordings.set(
        templateVersion,
        options.transformRecorded(fixture.name, templateVersion, content),
      );
    }
  }

  const captured = new Map<string, string>();
  const provider =
    options.mode === "replay"
      ? makeReplayProvider(recordings)
      : makeRecordingProvider(makeLiveProvider(), captured);
  const ai = new AiService(makeSupabaseStub(), provider);
  const userId = "ai-benchmark";

  try {
    const extraction = await extractCandidateProfile(ai, {
      userId,
      cvText: fixture.cvText,
      contentHash: fixture.contentHash,
      skipCache: true,
    });
    let tokensIn = extraction.meta.tokensIn;
    let tokensOut = extraction.meta.tokensOut;
    let profile = extraction.profile;

    // S3 where wired (spec §FR-1): only when there is something to adjudicate.
    const items = collectValidationItems(profile, extraction.report, fixture.cvText);
    let adjudicated = 0;
    let note: string | null = null;
    if (items.length > 0) {
      if (options.mode === "replay" && !recordings.has(cvValidateV1.templateVersion)) {
        note = `${items.length} flagged item(s); no ${cvValidateV1.templateVersion} recording — adjudication skipped`;
      } else {
        const validation = await runValidation(ai, {
          userId,
          profile,
          flaggedItems: items,
          cvText: fixture.cvText,
        });
        profile = validation.profile;
        adjudicated = validation.adjudicatedCount;
        tokensIn += validation.meta.tokensIn;
        tokensOut += validation.meta.tokensOut;
      }
    }

    // Fresh S2 pass over the final profile: the verbatim rate is measured on
    // what would actually persist.
    const report = verifyCandidateProfileEvidence(profile, fixture.cvText);
    return computeFixtureMetrics(
      fixture.name,
      profile,
      fixture.expected,
      report,
      { items: items.length, adjudicated, note },
      { tokensIn, tokensOut },
    );
  } catch (err) {
    return failedFixtureMetrics(fixture.name, err);
  } finally {
    if (options.mode === "record") {
      await saveCaptured(datasetDir, fixture.name, captured);
    }
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const datasetDir = options.datasetDir ?? DATASET_DIR;
  const fixtures = await loadCvFixtures(datasetDir);
  const results: FixtureMetrics[] = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(fixture, options, datasetDir));
  }
  const aggregate = aggregateMetrics(results);

  // CV×JD requirement-verdict pairs (T3.3): replay recorded extraction for
  // both sides, run the deterministic pre-pass, then the LLM verdict pass.
  const jdFixtures = await loadJdFixtures(datasetDir);
  const pairFixtures = await loadPairFixtures(datasetDir);
  const cvByName = new Map(fixtures.map((f) => [f.name, f]));
  const jdByName = new Map(jdFixtures.map((f) => [f.name, f]));
  const pairs: PairMetrics[] = [];
  for (const pair of pairFixtures) {
    const cv = cvByName.get(pair.cv);
    const jd = jdByName.get(pair.jd);
    if (cv === undefined || jd === undefined) {
      pairs.push(failedPairMetrics(pair, new Error(`unknown fixture in pair (cv=${pair.cv}, jd=${pair.jd})`)));
      continue;
    }
    pairs.push(await runPair(pair, cv, jd, options, datasetDir));
  }
  const pairAggregate = aggregatePairMetrics(pairs);

  return {
    mode: options.mode,
    datasetDir,
    templateVersion: cvExtractV1.templateVersion,
    validationTemplateVersion: cvValidateV1.templateVersion,
    jdTemplateVersion: jdExtractV1.templateVersion,
    matchTemplateVersion: MATCH_REQUIREMENTS_TEMPLATE_VERSION,
    fixtures: results,
    aggregate,
    pairs,
    pairAggregate,
    floors: checkHardFloors(aggregate, pairAggregate),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One CV×JD pair (T3.3): replay the recorded cv-extract/jd-extract responses,
 * run the deterministic pre-pass, then classify the unresolved remainder via
 * match-requirements.v1 (recorded in replay mode). Verdicts from both steps
 * are scored against the pair's expected verdicts.
 */
async function runPair(
  pair: PairFixture,
  cv: CvFixture,
  jd: JdFixture,
  options: BenchmarkOptions,
  datasetDir: string,
): Promise<PairMetrics> {
  const recordings = new Map<string, string>();
  if (options.mode === "replay") {
    // Recordings are keyed by templateVersion; each side contributes its own.
    for (const fixtureName of [cv.name, jd.name, pair.name]) {
      for (const [templateVersion, content] of await loadRecordings(datasetDir, fixtureName)) {
        recordings.set(
          templateVersion,
          options.transformRecorded
            ? options.transformRecorded(fixtureName, templateVersion, content)
            : content,
        );
      }
    }
  }

  const captured = new Map<string, string>();
  const provider =
    options.mode === "replay"
      ? makeReplayProvider(recordings)
      : makeRecordingProvider(makeLiveProvider(), captured);
  const ai = new AiService(makeSupabaseStub(), provider);
  const userId = "ai-benchmark";

  try {
    const extraction = await extractCandidateProfile(ai, {
      userId,
      cvText: cv.cvText,
      contentHash: cv.contentHash,
      skipCache: true,
    });
    const jobExtraction = await extractJobProfile(ai, {
      userId,
      jdText: jd.jdText,
      contentHash: `ai-benchmark:${jd.name}`,
      skipCache: true,
    });

    const { resolved, unresolved } = resolveBatch(
      jobExtraction.profile.requirements,
      extraction.profile,
    );
    const match =
      unresolved.length > 0
        ? await matchRequirements(ai, {
            userId,
            profile: extraction.profile,
            unresolved,
            skipCache: true,
          })
        : { verdicts: [] };

    return computePairMetrics(pair, [...resolved, ...match.verdicts], unresolved.length);
  } catch (err) {
    return failedPairMetrics(pair, err);
  } finally {
    if (options.mode === "record") {
      // Route each captured response to the fixture it belongs to.
      const index = systemPromptIndex();
      for (const [systemPrompt, content] of captured) {
        const templateVersion = index.get(systemPrompt);
        if (templateVersion === undefined) continue;
        const fixtureName =
          templateVersion === MATCH_REQUIREMENTS_TEMPLATE_VERSION
            ? pair.name
            : templateVersion === jdExtractV1.templateVersion
              ? jd.name
              : cv.name;
        await saveRecording(datasetDir, fixtureName, templateVersion, content);
      }
    }
  }
}
