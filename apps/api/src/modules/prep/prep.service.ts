import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Application } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  buildInterviewPrepPrompt,
  parseInterviewPrepResult,
  type InterviewPrepResult,
} from "../ai/prompts/interview-prep.v1.js";
import { truncateText } from "../ai/text.js";
import { CvsService } from "../cvs/cvs.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";

const MAX_CV_CHARS = 10_000;
const MAX_JD_CHARS = 10_000;
const MAX_TOKENS = 2000;

export interface InterviewPrepResponse extends InterviewPrepResult {
  cached: boolean;
}

/**
 * Interview prep (spec 004): likely questions for a tracked application's
 * role, with talking points drawn only from the active CV. Stateless — the
 * gateway's llm_cache already makes a repeat free, so nothing is persisted.
 */
@Injectable()
export class PrepService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly jobs: JobsService,
    private readonly cvs: CvsService,
    private readonly ai: AiService,
  ) {}

  async generate(
    userId: string,
    token: string,
    applicationId: string,
  ): Promise<InterviewPrepResponse> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("applications")
      .select("*")
      .eq("id", applicationId)
      .eq("user_id", userId)
      .maybeSingle();
    const application = data as Application | null;
    if (!application) throw new NotFoundException("Application not found");

    if (!application.job_id) {
      throw new UnprocessableEntityException({
        message: "Link this application to a job description to prepare for the interview",
        code: "no_linked_job",
      });
    }

    const job = await this.jobs.getOwned(userId, token, application.job_id);
    if (!job.description_text) {
      throw new UnprocessableEntityException({
        message: "The linked job has no description to prepare from",
        code: "no_job_description",
      });
    }

    const cv = await this.cvs.getActive(userId, token);
    if (!cv || !cv.extracted_text) {
      throw new UnprocessableEntityException({
        message: "Upload your CV first to generate interview prep",
        code: "no_active_cv",
      });
    }

    const cvText = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const jdText = truncateText(job.description_text, MAX_JD_CHARS);
    const prompt = buildInterviewPrepPrompt({
      cvText: cvText.text,
      jdText: jdText.text,
      title: job.title,
      company: job.company,
    });
    const result = await this.ai.generateJson<InterviewPrepResult>({
      userId,
      operation: "interview_prep",
      prompt,
      maxTokens: MAX_TOKENS,
      parse: parseInterviewPrepResult,
    });

    return { ...result.data, cached: result.cacheHit };
  }
}
