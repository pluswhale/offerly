import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CandidateProfile,
  CandidateProfileRow,
  CandidateProfileStatus,
} from "@offerly/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiService } from "../ai/ai.service.js";
import { verifyCandidateProfileEvidence, type EvidenceVerificationReport } from "../ai/evidence.js";
import {
  CV_EXTRACT_MAX_CHARS,
  extractCandidateProfile,
} from "../ai/profile-extraction.js";
import { applyUserCorrection, mergeUserCorrections } from "../ai/profile-merge.js";
import { collectValidationItems, runValidation } from "../ai/profile-validation.js";
import { cvExtractV1 } from "../ai/prompts/cv-extract.v1.js";
import { cvValidateV1 } from "../ai/prompts/cv-validate.v1.js";
import { candidateProfileSchema } from "../ai/schemas/candidate-profile.schema.js";
import { computeSummaryQuality } from "../ai/summary-quality.js";
import { truncateText } from "../ai/text.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";

/** The stage a retry resumes from (spec 003 §FR-1: persisted checkpoints). */
export type PipelineStage = "extracting" | "validating" | "persist";

export interface StageTiming {
  template_version?: string;
  cache_hit?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms: number;
  truncated?: boolean;
  analyzed_chars?: number;
  total?: number;
  verified?: number;
  flagged?: number;
  skipped?: boolean;
  adjudicated?: number;
}

/** candidate_profiles.stage_meta shape (spec §FR-1/§10 observability). */
export interface ProfileStageMeta {
  content_hash: string;
  template_versions: { extract: string; validate: string };
  /** Set while a stage is incomplete; cleared on 'ready'. Retry resumes here. */
  failed_stage?: PipelineStage;
  /** Sanitized error message — never contains CV text. */
  failure_reason?: string;
  /** Count of source:'user' facts carried over from the previous profile. */
  user_fields_preserved?: number;
  stages: { s1?: StageTiming; s2?: StageTiming; s3?: StageTiming };
}

export interface StartProfileResult {
  row: CandidateProfileRow;
  /** True when an up-to-date ready profile was returned without any LLM call. */
  reused: boolean;
  /** Fire-and-forget pipeline promise — exposed so tests can await it. */
  done?: Promise<void>;
}

/** Placeholder row content while S1 has not produced a profile yet. */
export function emptyCandidateProfile(): CandidateProfile {
  const unknown = { value: null, status: "unknown", confidence: 0, evidence: null } as const;
  return {
    headline: {
      title: { ...unknown },
      seniority: { ...unknown },
      total_years_experience: { ...unknown },
    },
    roles: [],
    skills: {
      programming_languages: [],
      frameworks: [],
      cloud_platforms: [],
      databases: [],
      devops_tools: [],
      other_technologies: [],
      soft_skills: [],
    },
    experience: {
      industries: [],
      domains: [],
      team_sizes_managed: { ...unknown },
      leadership: { ...unknown },
      leadership_scope: { ...unknown },
      management: { ...unknown },
      management_scope: { ...unknown },
    },
    education: [],
    certifications: [],
    languages: [],
    location: { current: { ...unknown }, work_authorization: [], remote_preference: { ...unknown } },
  };
}

const TEMPLATE_VERSIONS = {
  extract: cvExtractV1.templateVersion,
  validate: cvValidateV1.templateVersion,
} as const;

/**
 * Pipeline orchestrator + endpoints backend (spec 003 §FR-1/§FR-3/§FR-4,
 * T2.4/T2.5). Stages: S1+S2 extract/verify → user-merge → S3 validate →
 * persist. Every stage checkpoints into candidate_profiles.stage_meta so a
 * failure can resume from the failed stage without re-running earlier ones.
 * No queue infra: POST responds 202 and the pipeline runs in-process under
 * AiService's ConcurrencyLimiter; failures are caught and persisted as
 * status 'failed' — never unhandled rejections.
 */
@Injectable()
export class ProfilePipelineService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly cvs: CvsService,
  ) {}

  /**
   * POST /cvs/:id/profile. Idempotent per spec §FR-3: an up-to-date 'ready'
   * profile (same content_hash + template versions) is returned as-is with
   * zero LLM calls. A matching 'failed' row resumes from its failed stage.
   * Otherwise a fresh 'extracting' row is inserted and the pipeline runs
   * in-process after the response.
   */
  async start(userId: string, token: string, cvId: string): Promise<StartProfileResult> {
    const cv = await this.cvs.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }
    const db = this.supabase.forUser(token);

    const ready = await this.latestReadyRow(db, cvId, userId);
    if (ready && this.isCurrent(ready, cv.content_hash)) {
      return { row: ready, reused: true };
    }

    const { data: failed } = await db
      .from("candidate_profiles")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const failedRow = (failed as CandidateProfileRow | null) ?? null;
    if (failedRow && this.isCurrent(failedRow, cv.content_hash)) {
      const done = this.runSafely(userId, token, cvId, failedRow.id);
      return { row: failedRow, reused: false, done };
    }

    const { data: inserted, error } = await db
      .from("candidate_profiles")
      .insert({
        user_id: userId,
        cv_id: cvId,
        version: (ready?.version ?? 0) + 1,
        status: "extracting",
        profile: emptyCandidateProfile(),
        stage_meta: {
          content_hash: cv.content_hash,
          template_versions: TEMPLATE_VERSIONS,
          failed_stage: "extracting",
          stages: {},
        } satisfies ProfileStageMeta,
      })
      .select("*")
      .single();
    if (error || !inserted) {
      throw new Error(`Failed to create candidate profile row: ${error?.message}`);
    }
    const row = inserted as CandidateProfileRow;
    const done = this.runSafely(userId, token, cvId, row.id);
    return { row, reused: false, done };
  }

  /** GET /cvs/:id/profile — latest profile for the CV (any status) + stage meta. */
  async getLatest(userId: string, token: string, cvId: string): Promise<CandidateProfileRow> {
    await this.cvs.getOwned(userId, token, cvId);
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("candidate_profiles")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) throw new NotFoundException("No candidate profile for this CV yet");
    return data as CandidateProfileRow;
  }

  /**
   * PATCH /cvs/:id/profile (spec §FR-4, T2.5): one user correction.
   * The value becomes {status:'stated', confidence:1, evidence:null,
   * source:'user'} — distinguishable forever from AI-extracted facts.
   */
  async correct(
    userId: string,
    token: string,
    cvId: string,
    path: string,
    value: unknown,
  ): Promise<CandidateProfileRow> {
    await this.cvs.getOwned(userId, token, cvId);
    const db = this.supabase.forUser(token);
    const row = await this.latestReadyRow(db, cvId, userId);
    if (!row) {
      throw new NotFoundException("No ready candidate profile — run the pipeline first");
    }
    const parsed = candidateProfileSchema.safeParse(row.profile);
    if (!parsed.success) throw new Error("Stored candidate profile failed validation");

    if (!applyUserCorrection(parsed.data, path, value)) {
      throw new BadRequestException(`Unknown profile path: ${path}`);
    }
    parsed.data.summary_quality = computeSummaryQuality(parsed.data);

    const { data, error } = await db
      .from("candidate_profiles")
      .update({ profile: parsed.data, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error || !data) throw new Error(`Failed to store correction: ${error?.message}`);
    return data as CandidateProfileRow;
  }

  /** Fire-and-forget wrapper: failures are persisted, never unhandled. */
  private runSafely(userId: string, token: string, cvId: string, rowId: string): Promise<void> {
    return this.execute(userId, token, cvId, rowId).catch(async (err: unknown) => {
      // execute() already persists failures; this is belt-and-braces against
      // bugs in the failure-persistence path itself.
      console.error(
        `candidate profile pipeline crashed for cv ${cvId}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
    });
  }

  /**
   * The stage machine. Public so tests can await it directly. Resumes from
   * the stage recorded in stage_meta.failed_stage: 'extracting' re-runs S1
   * (cache-cheap), 'validating' reuses the stored post-S1 profile, 'persist'
   * only re-attempts the final write (a completed S3 is never re-run).
   */
  async execute(userId: string, token: string, cvId: string, rowId: string): Promise<void> {
    const db = this.supabase.forUser(token);
    const { data: rowData } = await db
      .from("candidate_profiles")
      .select("*")
      .eq("id", rowId)
      .eq("user_id", userId)
      .maybeSingle();
    const row = (rowData as CandidateProfileRow | null) ?? null;
    if (!row) return;

    const meta = this.normalizeMeta(row.stage_meta);
    let currentStage: PipelineStage = meta.failed_stage ?? "extracting";
    let profile = row.profile as CandidateProfile;
    let report: EvidenceVerificationReport | null = null;

    try {
      const cv = await this.cvs.getOwned(userId, token, cvId);
      if (!cv.extracted_text || !cv.content_hash) {
        throw new UnprocessableEntityException("CV has no extracted text");
      }
      // S2/S3 work against the same truncated text S1 saw (spec §FR-10).
      const cvText = truncateText(cv.extracted_text, CV_EXTRACT_MAX_CHARS).text;

      if (currentStage === "extracting") {
        const startedAt = Date.now();
        const extraction = await extractCandidateProfile(this.ai, {
          userId,
          cvText: cv.extracted_text,
          contentHash: cv.content_hash,
        });
        report = extraction.report;
        profile = extraction.profile;

        // User corrections from the previous ready profile win (spec §FR-4).
        const previousReady = await this.latestReadyRow(db, cvId, userId, rowId);
        let preserved = 0;
        if (previousReady) {
          const previous = candidateProfileSchema.safeParse(previousReady.profile);
          if (previous.success) preserved = mergeUserCorrections(previous.data, profile);
        }

        meta.stages.s1 = {
          template_version: extraction.meta.templateVersion,
          cache_hit: extraction.meta.cacheHit,
          tokens_in: extraction.meta.tokensIn,
          tokens_out: extraction.meta.tokensOut,
          duration_ms: Date.now() - startedAt,
          truncated: extraction.meta.truncated,
          analyzed_chars: extraction.meta.analyzedChars,
        };
        meta.stages.s2 = {
          total: report.totalCount,
          verified: report.verifiedCount,
          flagged: report.flagged.length,
          duration_ms: 0,
        };
        meta.user_fields_preserved = preserved;
        meta.failed_stage = "validating";
        await this.checkpoint(db, rowId, userId, "validating", profile, meta);
        currentStage = "validating";
      }

      if (currentStage === "validating") {
        // On resume the S2 report is recomputed — deterministic and free.
        report ??= verifyCandidateProfileEvidence(profile, cvText);
        const items = collectValidationItems(profile, report, cvText);
        const validation = await runValidation(this.ai, {
          userId,
          profile,
          flaggedItems: items,
          cvText,
        });
        profile = validation.profile;
        meta.stages.s3 = {
          template_version: validation.meta.templateVersion,
          skipped: validation.meta.skipped,
          adjudicated: validation.meta.adjudicatedCount,
          tokens_in: validation.meta.tokensIn,
          tokens_out: validation.meta.tokensOut,
          duration_ms: validation.meta.durationMs,
        };
        meta.failed_stage = "persist";
        await this.checkpoint(db, rowId, userId, "validating", profile, meta);
        currentStage = "persist";
      }

      // S4 — persist: summary_quality derived here, never extracted (§FR-2).
      profile.summary_quality = computeSummaryQuality(profile);
      // One 'ready' profile per CV (unique partial index): supersede predecessors.
      await db
        .from("candidate_profiles")
        .delete()
        .eq("cv_id", cvId)
        .eq("user_id", userId)
        .eq("status", "ready")
        .neq("id", rowId);
      delete meta.failed_stage;
      delete meta.failure_reason;
      await this.checkpoint(db, rowId, userId, "ready", profile, meta);
    } catch (err) {
      await this.markFailed(db, rowId, userId, meta, currentStage, err);
    }
  }

  private async checkpoint(
    db: SupabaseClient,
    rowId: string,
    userId: string,
    status: CandidateProfileStatus,
    profile: CandidateProfile,
    meta: ProfileStageMeta,
  ): Promise<void> {
    const { error } = await db
      .from("candidate_profiles")
      .update({
        status,
        profile,
        stage_meta: meta,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId)
      .eq("user_id", userId);
    if (error) throw new Error(`Failed to persist profile checkpoint: ${error.message}`);
  }

  private async markFailed(
    db: SupabaseClient,
    rowId: string,
    userId: string,
    meta: ProfileStageMeta,
    stage: PipelineStage,
    err: unknown,
  ): Promise<void> {
    const reason =
      err instanceof Error ? err.message.slice(0, 200) : "unknown pipeline error";
    await db
      .from("candidate_profiles")
      .update({
        status: "failed",
        stage_meta: { ...meta, failed_stage: stage, failure_reason: reason },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId)
      .eq("user_id", userId);
  }

  private async latestReadyRow(
    db: SupabaseClient,
    cvId: string,
    userId: string,
    excludeId?: string,
  ): Promise<CandidateProfileRow | null> {
    let query = db
      .from("candidate_profiles")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query.maybeSingle();
    return (data as CandidateProfileRow | null) ?? null;
  }

  /** Idempotency key: same CV content + same prompt versions (spec §FR-3). */
  private isCurrent(row: CandidateProfileRow, contentHash: string): boolean {
    const meta = row.stage_meta as Partial<ProfileStageMeta> | null;
    return (
      meta?.content_hash === contentHash &&
      meta.template_versions?.extract === TEMPLATE_VERSIONS.extract &&
      meta.template_versions?.validate === TEMPLATE_VERSIONS.validate
    );
  }

  private normalizeMeta(stageMeta: unknown): ProfileStageMeta {
    const meta = stageMeta as Partial<ProfileStageMeta> | null;
    return {
      content_hash: meta?.content_hash ?? "",
      template_versions: meta?.template_versions ?? TEMPLATE_VERSIONS,
      failed_stage: meta?.failed_stage,
      failure_reason: meta?.failure_reason,
      user_fields_preserved: meta?.user_fields_preserved,
      stages: meta?.stages ?? {},
    };
  }
}
