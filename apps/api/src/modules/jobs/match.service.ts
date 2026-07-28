import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { Cv, JobMatch } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  buildJobMatchPrompt,
  parseJobMatchResult,
  type JobMatchResult,
} from "../ai/prompts/job-match.v1.js";
import { truncateText } from "../ai/text.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { isLowConfidenceJd } from "./jd-validation.js";
import { JobsService } from "./jobs.service.js";

const MAX_CV_CHARS = 10_000;
const MAX_JD_CHARS = 10_000;

@Injectable()
export class MatchService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly jobs: JobsService,
    private readonly cvs: CvsService,
    private readonly ai: AiService,
  ) {}

  /**
   * POST /jobs/:id/match (T6.2). Cached on (cv hash + jd hash) — a repeated
   * match returns the stored row without any LLM call. Short/vague JDs get a
   * low-confidence warning instead of fake precision.
   */
  async match(userId: string, token: string, jobId: string): Promise<JobMatch> {
    const db = this.supabase.forUser(token);
    const job = await this.jobs.getOwned(userId, token, jobId);
    const cv = await this.requireActiveCv(userId, token);

    // Repeated match for the same CV+job pair → stored row, no LLM call.
    const { data: existing } = await db
      .from("job_matches")
      .select("*")
      .eq("job_id", jobId)
      .eq("cv_id", cv.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing as JobMatch;

    const jdText = job.description_text ?? "";
    const lowConfidence = isLowConfidenceJd(jdText);
    const cvText = truncateText(cv.extracted_text ?? "", MAX_CV_CHARS);
    const jdTruncated = truncateText(jdText, MAX_JD_CHARS);

    const prompt = buildJobMatchPrompt({
      cvText: cvText.text,
      jdText: jdTruncated.text,
      title: job.title,
      company: job.company,
    });
    const result = await this.ai.generateJson<JobMatchResult>({
      userId,
      operation: "job_match",
      prompt,
      maxTokens: 1200,
      parse: parseJobMatchResult,
    });

    const { data, error } = await db
      .from("job_matches")
      .insert({
        user_id: userId,
        cv_id: cv.id,
        job_id: jobId,
        score: result.data.score,
        result: {
          ...result.data,
          low_confidence: lowConfidence,
          ...(lowConfidence
            ? { warning: "This job description is short/vague — treat the score as a rough estimate" }
            : {}),
          truncated: cvText.truncated || jdTruncated.truncated,
          template_version: prompt.templateVersion,
        },
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store match: ${error.message}`);
    return data as JobMatch;
  }

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
}
