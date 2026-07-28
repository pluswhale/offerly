import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { CreateJobRequest, Job } from "@offerly/types";
import { normalizeForCache, sha256Hex } from "../ai/text.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { looksLikeJobDescription } from "./jd-validation.js";

@Injectable()
export class JobsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** POST /jobs (T6.1): heuristic validation + dedupe by content hash. */
  async create(userId: string, token: string, input: CreateJobRequest): Promise<Job> {
    const jdCheck = looksLikeJobDescription(input.description_text);
    if (!jdCheck.valid) {
      throw new UnprocessableEntityException({
        message: jdCheck.reason,
        code: "not_a_job_description",
      });
    }

    const db = this.supabase.forUser(token);
    const contentHash = sha256Hex(normalizeForCache(input.description_text));

    // Duplicate paste reuses the existing row.
    const { data: existing } = await db
      .from("jobs")
      .select("*")
      .eq("user_id", userId)
      .eq("content_hash", contentHash)
      .limit(1)
      .maybeSingle();
    if (existing) return existing as Job;

    const { data, error } = await db
      .from("jobs")
      .insert({
        user_id: userId,
        title: input.title,
        company: input.company ?? null,
        url: input.url ?? null,
        description_text: input.description_text,
        content_hash: contentHash,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to save job: ${error.message}`);
    return data as Job;
  }

  async getOwned(userId: string, token: string, jobId: string): Promise<Job> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) throw new NotFoundException("Job not found");
    return data as Job;
  }
}
