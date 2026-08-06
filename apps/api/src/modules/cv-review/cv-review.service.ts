import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CandidateProfile,
  CandidateProfileRow,
  Cv,
  CvAnalysis,
} from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  createCvReviewTemplate,
  CV_REVIEW_TEMPLATE_VERSION,
  type CvReviewDepth,
} from "../ai/prompts/cv-review.v2.js";
import { truncateText } from "../ai/text.js";
import { ProfilePipelineService } from "../candidate-profiles/profile-pipeline.service.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";

const MAX_CV_CHARS = 12_000; // review input cap (unchanged from cv-analysis.v1)

/**
 * CV quality review orchestration (spec 003 §FR-9, T4.1). The review consumes
 * the ready Candidate Profile + truncated CV text via cv-review.v2 — never
 * the raw text alone. A missing/stale profile triggers the pipeline inline
 * (same pattern as MatchService.requireReadyProfile, spec §FR-6); a pipeline
 * failure fails the review with the same 503 — there is no raw-text fallback.
 *
 * Unchanged from v1: the `cv_analyses` table, the {score, sections,
 * improvements} result contract (additive field_ref on improvements),
 * free=basic/pro=deep depth, content-hash-keyed caching and the 'cv_analysis'
 * usage op.
 */
@Injectable()
export class CvReviewService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly cvs: CvsService,
    private readonly pipeline: ProfilePipelineService,
  ) {}

  /**
   * POST /cvs/:id/analyze. Cached on (depth, content hash, profile content) —
   * re-analyzing an unchanged CV + profile is a cache hit and free.
   */
  async analyze(
    userId: string,
    token: string,
    cvId: string,
    depth: CvReviewDepth,
  ): Promise<CvAnalysis> {
    const cv = await this.cvs.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }

    const { row: profileRow, profile } = await this.requireReadyProfile(userId, token, cv);

    const truncated = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const result = await this.ai.generateFromTemplate({
      userId,
      operation: "cv_analysis",
      template: createCvReviewTemplate({ profile, depth }),
      input: {
        profile,
        cvText: truncated.text,
        contentHash: cv.content_hash,
        truncated: truncated.truncated,
      },
    });

    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("cv_analyses")
      .insert({
        cv_id: cvId,
        user_id: userId,
        score: result.data.score,
        result: {
          ...result.data,
          truncated: truncated.truncated,
          analyzed_chars: truncated.text.length,
          template_version: CV_REVIEW_TEMPLATE_VERSION,
          profile_version: profileRow.version,
        },
        depth,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store analysis: ${error.message}`);
    return data as CvAnalysis;
  }

  /** GET /cvs/:id/analyses — rows returned as stored; old v1 shapes stay readable. */
  async listAnalyses(userId: string, token: string, cvId: string): Promise<CvAnalysis[]> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("cv_analyses")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list analyses: ${error.message}`);
    return (data ?? []) as CvAnalysis[];
  }

  /**
   * The ready Candidate Profile for the CV (spec §FR-9: the profile is the
   * input). pipeline.start() is idempotent: a current ready profile returns
   * with zero LLM calls; otherwise the pipeline runs inline. A pipeline
   * failure fails the review — there is no raw-text fallback.
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
}
