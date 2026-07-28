import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { GenerateApplicationRequest } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  buildApplyPrompt,
  parseApplyResult,
  type ApplyGenerationResult,
} from "../ai/prompts/apply-generate.v1.js";
import { truncateText } from "../ai/text.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { JobsService } from "./jobs.service.js";

const MAX_CV_CHARS = 10_000;
const MAX_JD_CHARS = 10_000;

export interface ApplyResponse extends ApplyGenerationResult {
  conversation_id: string;
}

/**
 * Apply assistant (T7.1): cover letter + answers + recommendations from the
 * active CV and the JD. The honesty rule lives in the prompt (never invent
 * experience, flag gaps). Each generation is stored as an apply_assistant
 * conversation so artifacts stay retrievable.
 */
@Injectable()
export class ApplyService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly jobs: JobsService,
    private readonly cvs: CvsService,
    private readonly ai: AiService,
  ) {}

  async generate(
    userId: string,
    token: string,
    jobId: string,
    input: GenerateApplicationRequest,
  ): Promise<ApplyResponse> {
    const db = this.supabase.forUser(token);
    const job = await this.jobs.getOwned(userId, token, jobId);
    const cv = await this.cvs.getActive(userId, token);
    if (!cv || !cv.extracted_text) {
      throw new UnprocessableEntityException({
        message: "Upload your CV first to generate an application",
        code: "no_active_cv",
      });
    }

    const cvText = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const jdText = truncateText(job.description_text ?? "", MAX_JD_CHARS);
    const prompt = buildApplyPrompt({
      cvText: cvText.text,
      jdText: jdText.text,
      title: job.title,
      company: job.company,
      instruction: input.instruction,
    });
    const result = await this.ai.generateJson<ApplyGenerationResult>({
      userId,
      operation: "apply_generate",
      prompt,
      maxTokens: 2500,
      parse: parseApplyResult,
    });

    // Persist the artifact (retrievable from the application later, T7.2).
    const { data: conversation, error } = await db
      .from("ai_conversations")
      .insert({
        user_id: userId,
        kind: "apply_assistant",
        context: { cv_id: cv.id, job_id: jobId },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to store generation: ${error.message}`);
    const conversationId = (conversation as { id: string }).id;
    await db.from("ai_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify(result.data),
    });

    return { conversation_id: conversationId, ...result.data };
  }
}
