import { Injectable } from "@nestjs/common";
import type { JobProfile, JobProfileRow } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import { extractJobProfile } from "../ai/job-extraction.js";
import { jdExtractV1 } from "../ai/prompts/jd-extract.v1.js";
import { normalizeForCache, sha256Hex } from "../ai/text.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { JobsService } from "./jobs.service.js";

export interface JobProfileResult {
  /** The job_profiles row (stored or freshly written). */
  row: JobProfileRow;
  profile: JobProfile;
  /** True when a stored row current for the job's content hash was reused. */
  reused: boolean;
}

/**
 * Lazy JD structuring (spec 003 §FR-5, T3.1): the first consumer of a job's
 * structured profile (the match flow, T3.4) triggers one jd-extract.v1 call;
 * the result is stored on job_profiles keyed by the job's content_hash and
 * re-extracted only when the JD text or the template version changes.
 *
 * Cross-user reuse comes from the global llm_cache (cacheInput = content
 * hash), NOT from sharing job_profiles rows — jobs rows are per-user, so each
 * user keeps their own job_profiles row.
 */
@Injectable()
export class JobProfileService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Stored profile if current, otherwise extract → verify → persist → return.
   * Throws NotFoundException for a job the user does not own.
   */
  async getOrExtract(
    userId: string,
    token: string,
    jobId: string,
  ): Promise<JobProfileResult> {
    const job = await this.jobs.getOwned(userId, token, jobId);
    const contentHash =
      job.content_hash ?? sha256Hex(normalizeForCache(job.description_text ?? ""));
    const db = this.supabase.forUser(token);

    const { data: existing } = await db
      .from("job_profiles")
      .select("*")
      .eq("job_id", jobId)
      .maybeSingle();
    const stored = (existing as JobProfileRow | null) ?? null;
    if (
      stored &&
      stored.content_hash === contentHash &&
      stored.template_version === jdExtractV1.templateVersion
    ) {
      return { row: stored, profile: stored.profile as JobProfile, reused: true };
    }

    const extraction = await extractJobProfile(this.ai, {
      userId,
      jdText: job.description_text ?? "",
      contentHash,
    });

    const { data: saved, error } = await db
      .from("job_profiles")
      .upsert(
        {
          job_id: jobId,
          profile: extraction.profile,
          template_version: jdExtractV1.templateVersion,
          content_hash: contentHash,
        },
        { onConflict: "job_id" },
      )
      .select("*")
      .single();
    if (error || !saved) {
      throw new Error(`Failed to store job profile: ${error?.message}`);
    }
    const row = saved as JobProfileRow;
    return { row, profile: extraction.profile, reused: false };
  }
}
