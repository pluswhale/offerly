import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CandidateProfile,
  CandidateProfileRow,
  Cv,
  JobMatch,
  JobRequirement,
  MatchRecommendation,
  MatchReportV2,
  RequirementCategory,
  RequirementImportance,
  RequirementVerdict,
} from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import { matchRequirements } from "../ai/matching/match-requirements.js";
import { resolveBatch } from "../ai/matching/prepass.js";
import {
  buildStaticComponents,
  type CategorizedVerdict,
} from "../ai/matching/static-components.js";
import { computeScore, WEIGHTS_V1 } from "../ai/matching/weights.js";
import { jdExtractV1 } from "../ai/prompts/jd-extract.v1.js";
import { MATCH_REQUIREMENTS_TEMPLATE_VERSION } from "../ai/prompts/match-requirements.v1.js";
import { createRecommendationsTemplate } from "../ai/prompts/recommendations.v1.js";
import { normalizeForCache, sha256Hex } from "../ai/text.js";
import {
  ProfilePipelineService,
  type ProfileStageMeta,
} from "../candidate-profiles/profile-pipeline.service.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { isLowConfidenceJd } from "./jd-validation.js";
import { JobProfileService } from "./job-profile.service.js";
import { JobsService } from "./jobs.service.js";

/**
 * Requirement text/category/importance snapshotted into the report (T3.5):
 * verdicts reference requirements by id only, and the job profile is not
 * exposed over the API — the UI needs the text to render the report.
 */
export interface MatchRequirementSnapshot {
  id: string;
  text: string;
  category: RequirementCategory;
  importance: RequirementImportance;
}

/**
 * Stored `job_matches.result` v2 (spec 003 §FR-8): the MatchReportV2 contract
 * plus the JD low-confidence warning and the reuse key. The reuse key makes
 * "identical inputs" precise — a stored report is current only while the
 * profile content, job content, weights version and template versions all
 * match; anything else triggers a fresh computation (old v1 rows never do,
 * so they are simply recomputed on the next POST).
 */
export interface StoredMatchResultV2 extends MatchReportV2 {
  /** Flat requirement snapshot the verdicts reference by id (see above). */
  requirements: MatchRequirementSnapshot[];
  /**
   * Prioritized next actions from recommendations.v1 (T4.2), computed with
   * the report and stored on it. Optional: absent on a degraded compute
   * (recommendations failure never fails the match) and on pre-T4.2 rows.
   */
  recommendations?: MatchRecommendation[];
  /** Heuristic JD quality flag (jd-validation.ts) — surfaces as a warning. */
  jd_low_confidence: boolean;
  warning?: string;
  /** Reuse key (spec §FR-8): candidate_profiles.version of the input profile. */
  profile_version: number;
  /** Reuse key: sha256 of the profile JSON (catches user corrections). */
  profile_content_hash: string;
  /** Reuse key: jobs.content_hash the report was computed from. */
  job_content_hash: string;
}

/**
 * Match orchestration v2 (spec 003 §FR-6/§FR-7/§FR-8, T3.4). The only
 * candidate input is the ready Candidate Profile — raw CV text is never read
 * here. Assembly: JD profile (T3.1) → deterministic pre-pass (T3.2) → LLM
 * verdicts for the remainder (T3.3) → computeScore (T1.3) → low-confidence
 * gates. The score is computed in code; the LLM never emits it.
 *
 * Billing semantics are unchanged: exactly one non-cache-hit 'job_match'
 * usage row per computed report (quota counts per match operation). The
 * recommendations.v1 call (T4.2) logs that row with its real tokens when the
 * LLM actually ran; otherwise a zero-token quota row is recorded. Internal
 * stages log their own cv_profile / jd_extract / match_requirements rows.
 */
@Injectable()
export class MatchService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly jobs: JobsService,
    private readonly cvs: CvsService,
    private readonly ai: AiService,
    private readonly pipeline: ProfilePipelineService,
    private readonly jobProfiles: JobProfileService,
  ) {}

  async match(userId: string, token: string, jobId: string): Promise<JobMatch> {
    const db = this.supabase.forUser(token);
    const job = await this.jobs.getOwned(userId, token, jobId);
    const cv = await this.requireActiveCv(userId, token);

    // FR-6: require a ready profile for the active CV — building it inline
    // when absent or stale, never falling back to raw CV text.
    const { row: profileRow, profile } = await this.requireReadyProfile(userId, token, cv);
    const profileMeta = profileRow.stage_meta as ProfileStageMeta;
    const profileHash = sha256Hex(JSON.stringify(profile));
    const jobContentHash =
      job.content_hash ?? sha256Hex(normalizeForCache(job.description_text ?? ""));

    // Repeated match with identical inputs → stored row, zero LLM calls (AC-4).
    const { data: existing } = await db
      .from("job_matches")
      .select("*")
      .eq("job_id", jobId)
      .eq("cv_id", cv.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const stored = (existing as JobMatch | null) ?? null;
    if (
      stored &&
      this.isCurrentReport(stored, {
        profileHash,
        jobContentHash,
        cvExtractVersion: profileMeta.template_versions.extract,
      })
    ) {
      return stored;
    }

    const { profile: jobProfile } = await this.jobProfiles.getOrExtract(userId, token, jobId);

    const { resolved, unresolved } = resolveBatch(jobProfile.requirements, profile);
    const llm = await matchRequirements(this.ai, { userId, profile, unresolved });
    const { verdicts, categorized } = mergeVerdicts(jobProfile.requirements, resolved, llm.verdicts);

    const components = buildStaticComponents(profile, jobProfile, categorized);
    const computed = computeScore(categorized, components);

    const jdLowConfidence = isLowConfidenceJd(job.description_text ?? "");
    const result: StoredMatchResultV2 = {
      version: 2,
      score: computed.score,
      weights_version: computed.weights_version,
      breakdown: computed.breakdown,
      verdicts,
      requirements: jobProfile.requirements.map((req) => ({
        id: req.id,
        text: req.text.value ?? req.id,
        category: req.category,
        importance: req.importance,
      })),
      low_confidence: computed.low_confidence,
      unknown_must_have_share: computed.unknown_must_have_share,
      jd_low_confidence: jdLowConfidence,
      ...(jdLowConfidence
        ? { warning: "This job description is short/vague — treat the score as a rough estimate" }
        : {}),
      template_versions: {
        cv_extract: profileMeta.template_versions.extract,
        jd_extract: jdExtractV1.templateVersion,
        match_requirements: llm.meta.templateVersion,
      },
      profile_version: profileRow.version,
      profile_content_hash: profileHash,
      job_content_hash: jobContentHash,
    };

    // T4.2: next-action advice computed with the fresh report and stored on
    // it (the reuse path above already carries it). Best-effort — a failure
    // degrades the report instead of failing the match.
    const recommendations = await this.recommendations(userId, result);
    if (recommendations.data) result.recommendations = recommendations.data;

    const { data, error } = await db
      .from("job_matches")
      .insert({
        user_id: userId,
        cv_id: cv.id,
        job_id: jobId,
        score: computed.score,
        result,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store match: ${error.message}`);

    // Exactly one non-cache-hit 'job_match' row per computed report: the
    // recommendations gateway call already logged it (with real tokens) when
    // it hit the LLM; cache hits and degraded computes fall back to the
    // zero-token quota row (see class docstring).
    if (!recommendations.countedUsage) {
      await this.ai.recordUsage(userId, "job_match");
    }
    return data as JobMatch;
  }

  /**
   * recommendations.v1 (T4.2): 2–4 next actions grounded in the report's
   * verdicts. Cached per report hash (profile + job content + weights
   * version), so identical report inputs never pay for it twice.
   * countedUsage=false tells the caller the quota row is still owed (the
   * gateway logged either nothing — failure — or a cache-hit row).
   */
  private async recommendations(
    userId: string,
    result: StoredMatchResultV2,
  ): Promise<{ data: MatchRecommendation[] | null; countedUsage: boolean }> {
    try {
      const res = await this.ai.generateFromTemplate({
        userId,
        operation: "job_match",
        template: createRecommendationsTemplate({
          requirementIds: result.requirements.map((req) => req.id),
        }),
        input: {
          report: result,
          profileContentHash: result.profile_content_hash,
          jobContentHash: result.job_content_hash,
        },
      });
      return { data: res.data.recommendations, countedUsage: !res.cacheHit };
    } catch (err) {
      console.warn(
        `recommendations.v1 failed; storing the report without them: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return { data: null, countedUsage: false };
    }
  }

  /**
   * GET /jobs/:id/match — the latest stored report, whatever its shape:
   * v1 rows stay readable as-is (the UI feature-detects, T3.5).
   */
  async getLatest(userId: string, token: string, jobId: string): Promise<JobMatch> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("job_matches")
      .select("*")
      .eq("job_id", jobId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) {
      throw new UnprocessableEntityException({
        message: "No match computed for this job yet — POST /jobs/:id/match first",
        code: "no_match",
      });
    }
    return data as JobMatch;
  }

  /**
   * The ready Candidate Profile for the active CV (spec §FR-6). start() is
   * idempotent: a current ready profile returns with zero LLM calls; otherwise
   * the pipeline runs inline (resuming a failed row from its failed stage).
   * A pipeline failure fails the match — there is no raw-text fallback.
   */
  private async requireReadyProfile(
    userId: string,
    token: string,
    cv: Cv,
  ): Promise<{ row: CandidateProfileRow; profile: CandidateProfile }> {
    const started = await this.pipeline.start(userId, token, cv.id);
    if (started.done) await started.done;

    const latest = await this.pipeline.getLatest(userId, token, cv.id).catch(() => null);
    if (!latest || latest.status !== "ready") {
      throw new ServiceUnavailableException({
        message: "We couldn't build your candidate profile — please try again",
        code: "profile_pipeline_failed",
      });
    }
    return { row: latest, profile: latest.profile as CandidateProfile };
  }

  /** The CV gate (existence + text), NOT a matching input — see FR-6. */
  private async requireActiveCv(userId: string, token: string): Promise<Cv> {
    const cv = await this.cvs.getActive(userId, token);
    if (!cv || !cv.extracted_text) {
      throw new UnprocessableEntityException({
        message: "Upload your CV first to compute a match",
        code: "no_active_cv",
      });
    }
    return cv;
  }

  private isCurrentReport(
    stored: JobMatch,
    key: { profileHash: string; jobContentHash: string; cvExtractVersion: string },
  ): boolean {
    const result = stored.result as Partial<StoredMatchResultV2> | null;
    return (
      result?.version === 2 &&
      // Pre-snapshot v2 rows (stored before T3.5) recompute — the UI needs them.
      Array.isArray(result.requirements) &&
      result.weights_version === WEIGHTS_V1.weightsVersion &&
      result.profile_content_hash === key.profileHash &&
      result.job_content_hash === key.jobContentHash &&
      result.template_versions?.cv_extract === key.cvExtractVersion &&
      result.template_versions?.jd_extract === jdExtractV1.templateVersion &&
      result.template_versions?.match_requirements === MATCH_REQUIREMENTS_TEMPLATE_VERSION
    );
  }
}

/**
 * Pre-pass + LLM verdicts merged in requirement order (deterministic output —
 * identical inputs produce a bit-identical report, spec AC-4). Coverage is
 * total by construction: the pre-pass resolves or forwards every requirement,
 * and match-requirements.v1 validates exactly one verdict per forwarded id.
 */
function mergeVerdicts(
  requirements: readonly JobRequirement[],
  resolved: readonly RequirementVerdict[],
  llmVerdicts: readonly RequirementVerdict[],
): { verdicts: RequirementVerdict[]; categorized: CategorizedVerdict[] } {
  const byRequirement = new Map<string, RequirementVerdict>();
  for (const verdict of [...resolved, ...llmVerdicts]) {
    byRequirement.set(verdict.requirement_id, verdict);
  }
  const verdicts: RequirementVerdict[] = [];
  const categorized: CategorizedVerdict[] = [];
  for (const req of requirements) {
    const verdict = byRequirement.get(req.id);
    if (!verdict) continue;
    verdicts.push(verdict);
    categorized.push({
      importance: req.importance,
      verdict: verdict.verdict,
      category: req.category,
    });
  }
  return { verdicts, categorized };
}
