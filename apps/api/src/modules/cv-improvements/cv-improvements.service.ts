import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CandidateProfile, CvImprovement, RequirementVerdict } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  createBulletImproveTemplate,
  BULLET_IMPROVE_TEMPLATE_VERSION,
  type BulletImproveDepth,
} from "../ai/prompts/bullet-improve.v1.js";
import {
  createSentenceRewriteTemplate,
  SENTENCE_REWRITE_TEMPLATE_VERSION,
  type SentenceRewriteDepth,
} from "../ai/prompts/sentence-rewrite.v1.js";
import type { BulletImproveCategory } from "../ai/schemas/bullet-improve.schema.js";
import { candidateProfileSchema } from "../ai/schemas/candidate-profile.schema.js";
import type { SentenceRewriteCategory } from "../ai/schemas/sentence-rewrite.schema.js";
import { normalizeForMatch, truncateText } from "../ai/text.js";
import { CvsService } from "../cvs/cvs.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { findNewEntities } from "./entity-guard.js";
import {
  HEALTH_TEMPLATE_VERSION,
  runHealthDetectors,
  type HealthItem,
  type HealthMatchReport,
} from "./health/index.js";

const MAX_CV_CHARS = 12_000; // same input cap as the review (cv-review.service.ts)

/** spec 003 §FR-12 — per-suggestion accept/reject lifecycle for the UI (T5.3). */
export type ImprovementSuggestionStatus = "pending" | "accepted" | "rejected";

/**
 * One stored suggestion — the model's output plus the server-assigned
 * id and status. This is the exact per-item JSON the improvements UI renders
 * (❌ original_span / ✅ improved + reason + category badge + accept/reject).
 * Category is per improvement type: sentence categories (§FR-12) or bullet
 * categories (§FR-13).
 */
export interface ImprovementSuggestion {
  id: string;
  original_span: string;
  improved: string;
  reason: string;
  category: SentenceRewriteCategory | BulletImproveCategory;
  status: ImprovementSuggestionStatus;
}

/**
 * Stored `cv_improvements.suggestions` payload for type 'sentence' (narrower
 * jsonb shapes live in the producing module per packages/types convention).
 * content_hash + depth double as the reuse key: a row is current only while
 * the CV content and the requested depth match (mirrors match-report reuse).
 */
export interface SentenceImprovementsPayload {
  content_hash: string;
  depth: SentenceRewriteDepth;
  truncated: boolean;
  /** Suggestions dropped by the verbatim-span check before storage. */
  dropped_count: number;
  items: ImprovementSuggestion[];
}

/**
 * Stored `cv_improvements.suggestions` payload for type 'bullet' (spec §FR-13,
 * T5.2). Same envelope as the sentence payload; dropped_count additionally
 * covers suggestions rejected by the new-entity guard (entity-guard.ts).
 */
export interface BulletImprovementsPayload {
  content_hash: string;
  depth: BulletImproveDepth;
  truncated: boolean;
  /** Suggestions dropped by the verbatim-span or new-entity check before storage. */
  dropped_count: number;
  items: ImprovementSuggestion[];
}

/**
 * Stored `cv_improvements.suggestions` payload for type 'health' (spec §FR-14,
 * T5.4/T5.5) — the exact JSON the CV Health UI renders. Unlike the rewriter
 * payloads there is no depth and no dropped_count (detectors are
 * deterministic, nothing is dropped); reuse is content_hash +
 * template_version (HEALTH_TEMPLATE_VERSION, currently 'health.v2') only.
 */
export interface HealthImprovementsPayload {
  content_hash: string;
  items: HealthItem[];
}

/**
 * CV improvement orchestration (spec 003 §FR-12/§FR-13/§FR-14, T5.1/T5.2/
 * T5.4). The rewriters run synchronously (single cheap LLM call, like cv
 * analyze), verify every original_span verbatim against the CV text
 * (S2-style check — unverifiable spans are dropped before storage so the UI
 * can locate spans by exact match), and store one cv_improvements row per
 * run. The bullet path additionally applies the new-entity guard
 * (entity-guard.ts). The health path is pure code — no LLM call at all.
 *
 * Reuse: if the latest row of the requested type for the CV matches the
 * current content hash + depth + template version, it is returned without
 * any LLM call.
 */
@Injectable()
export class CvImprovementsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
    private readonly cvs: CvsService,
  ) {}

  /** POST /cvs/:id/improvements?type=sentence */
  async generateSentences(
    userId: string,
    token: string,
    cvId: string,
    depth: SentenceRewriteDepth,
  ): Promise<CvImprovement> {
    const cv = await this.cvs.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }

    const db = this.supabase.forUser(token);
    const { data: latest } = await db
      .from("cv_improvements")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .eq("type", "sentence")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const stored = (latest as CvImprovement | null) ?? null;
    if (
      stored &&
      isCurrentPayload(stored, cv.content_hash, depth, SENTENCE_REWRITE_TEMPLATE_VERSION)
    ) {
      return stored;
    }

    const truncated = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const result = await this.ai.generateFromTemplate({
      userId,
      operation: "cv_improve",
      template: createSentenceRewriteTemplate({ depth }),
      input: {
        cvText: truncated.text,
        contentHash: cv.content_hash,
        truncated: truncated.truncated,
      },
    });

    // Verbatim check (spec §FR-12): spans must substring-match the full CV
    // text after normalizeForMatch; unverifiable spans are dropped, not stored.
    const haystack = normalizeForMatch(cv.extracted_text);
    let dropped = 0;
    const items: ImprovementSuggestion[] = [];
    for (const suggestion of result.data.suggestions) {
      const needle = normalizeForMatch(suggestion.original_span);
      if (needle.length > 0 && haystack.includes(needle)) {
        items.push({ id: randomUUID(), ...suggestion, status: "pending" });
      } else {
        dropped += 1;
      }
    }

    const payload: SentenceImprovementsPayload = {
      content_hash: cv.content_hash,
      depth,
      truncated: truncated.truncated,
      dropped_count: dropped,
      items,
    };
    const { data, error } = await db
      .from("cv_improvements")
      .insert({
        cv_id: cvId,
        user_id: userId,
        type: "sentence",
        suggestions: payload,
        template_version: SENTENCE_REWRITE_TEMPLATE_VERSION,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store improvements: ${error.message}`);
    return data as CvImprovement;
  }

  /**
   * POST /cvs/:id/improvements?type=bullet — spec 003 §FR-13 (T5.2). Same
   * orchestration as the sentence rewriter, plus the deterministic
   * new-entity guard: after the verbatim-span check, any rewrite naming a
   * technology/product/company absent from its original span is dropped
   * (counted in dropped_count) — rewrites may rephrase, never add facts.
   * Reuse mirrors sentences: latest 'bullet' row matching content hash +
   * depth + template version is served without an LLM call.
   */
  async generateBullets(
    userId: string,
    token: string,
    cvId: string,
    depth: BulletImproveDepth,
  ): Promise<CvImprovement> {
    const cv = await this.cvs.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }

    const db = this.supabase.forUser(token);
    const { data: latest } = await db
      .from("cv_improvements")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .eq("type", "bullet")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const stored = (latest as CvImprovement | null) ?? null;
    if (
      stored &&
      isCurrentPayload(stored, cv.content_hash, depth, BULLET_IMPROVE_TEMPLATE_VERSION)
    ) {
      return stored;
    }

    const truncated = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const result = await this.ai.generateFromTemplate({
      userId,
      operation: "cv_improve",
      template: createBulletImproveTemplate({ depth }),
      input: {
        cvText: truncated.text,
        contentHash: cv.content_hash,
        truncated: truncated.truncated,
      },
    });

    const haystack = normalizeForMatch(cv.extracted_text);
    let dropped = 0;
    const items: ImprovementSuggestion[] = [];
    for (const suggestion of result.data.suggestions) {
      // Verbatim check (same as sentences): the span must locate in the CV text.
      const needle = normalizeForMatch(suggestion.original_span);
      if (needle.length === 0 || !haystack.includes(needle)) {
        dropped += 1;
        continue;
      }
      // New-entity guard (spec §FR-13): no new technologies/products/companies.
      if (findNewEntities(suggestion.original_span, suggestion.improved).length > 0) {
        dropped += 1;
        continue;
      }
      items.push({ id: randomUUID(), ...suggestion, status: "pending" });
    }

    const payload: BulletImprovementsPayload = {
      content_hash: cv.content_hash,
      depth,
      truncated: truncated.truncated,
      dropped_count: dropped,
      items,
    };
    const { data, error } = await db
      .from("cv_improvements")
      .insert({
        cv_id: cvId,
        user_id: userId,
        type: "bullet",
        suggestions: payload,
        template_version: BULLET_IMPROVE_TEMPLATE_VERSION,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store improvements: ${error.message}`);
    return data as CvImprovement;
  }

  /**
   * POST /cvs/:id/improvements?type=health — spec 003 §FR-14 (T5.4/T5.5).
   * Fully deterministic: the detectors (health/) run in code over the CV
   * text, the latest ready candidate profile and the user's existing v2
   * match reports.
   * NO LLM call and NO usage_records row — the endpoint keeps the
   * @Requires('cv_analysis') gate for consistency with the rewriters, but
   * the monthly quota counts usage_records ops (entitlements.service.ts
   * QUOTA_OPERATIONS) and this path records none, so health checks never
   * consume quota. Reuse mirrors the rewriters minus depth: the latest
   * 'health' row matching the CV content hash + template version is served
   * as-is.
   */
  async generateHealth(userId: string, token: string, cvId: string): Promise<CvImprovement> {
    const cv = await this.cvs.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }

    const db = this.supabase.forUser(token);
    const { data: latest } = await db
      .from("cv_improvements")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .eq("type", "health")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const stored = (latest as CvImprovement | null) ?? null;
    if (stored !== null && stored.template_version === HEALTH_TEMPLATE_VERSION) {
      const payload = stored.suggestions as Partial<HealthImprovementsPayload> | null;
      if (payload?.content_hash === cv.content_hash) return stored;
    }

    const [{ data: profileRow }, { data: matchRows }] = await Promise.all([
      db
        .from("candidate_profiles")
        .select("profile")
        .eq("cv_id", cvId)
        .eq("user_id", userId)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("job_matches")
        .select("job_id, result")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);

    // An unparsable stored profile degrades to "no profile yet" (same
    // pattern as the coach's v2 manifest) rather than failing the run.
    let profile: CandidateProfile | null = null;
    if (profileRow) {
      const parsed = candidateProfileSchema.safeParse(
        (profileRow as { profile: unknown }).profile,
      );
      if (parsed.success) profile = parsed.data;
    }
    const matchReports = ((matchRows ?? []) as { job_id: string; result: unknown }[])
      .map(toHealthMatchReport)
      .filter((report): report is HealthMatchReport => report !== null);

    const items: HealthItem[] = runHealthDetectors({
      cvText: cv.extracted_text,
      profile,
      matchReports,
    }).map((draft) => ({ ...draft, id: randomUUID(), status: "pending" }));

    const payload: HealthImprovementsPayload = {
      content_hash: cv.content_hash,
      items,
    };
    const { data, error } = await db
      .from("cv_improvements")
      .insert({
        cv_id: cvId,
        user_id: userId,
        type: "health",
        suggestions: payload,
        template_version: HEALTH_TEMPLATE_VERSION,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store improvements: ${error.message}`);
    return data as CvImprovement;
  }

  /** GET /cvs/:id/improvements — all rows for the CV, newest first. */
  async list(userId: string, token: string, cvId: string): Promise<CvImprovement[]> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("cv_improvements")
      .select("*")
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list improvements: ${error.message}`);
    return (data ?? []) as CvImprovement[];
  }

  /**
   * PATCH /cvs/:id/improvements/:rowId — flip one suggestion's status
   * (accepted|rejected) inside the stored jsonb; pending suggestions are the
   * user's to-do list (spec §FR-12: MVP does not auto-rewrite the CV file).
   * Works for health items too — 'rejected' is the dismiss action.
   */
  async updateSuggestionStatus(
    userId: string,
    token: string,
    cvId: string,
    rowId: string,
    suggestionId: string,
    status: Exclude<ImprovementSuggestionStatus, "pending">,
  ): Promise<CvImprovement> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("cv_improvements")
      .select("*")
      .eq("id", rowId)
      .eq("cv_id", cvId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) throw new NotFoundException("Improvement row not found");
    const row = data as CvImprovement;

    const payload = row.suggestions as
      | SentenceImprovementsPayload
      | BulletImprovementsPayload
      | HealthImprovementsPayload;
    const items = (Array.isArray(payload.items) ? payload.items : []) as (
      | ImprovementSuggestion
      | HealthItem
    )[];
    const item = items.find((candidate) => candidate.id === suggestionId);
    if (!item) throw new NotFoundException("Suggestion not found");
    item.status = status;

    const { data: updated, error } = await db
      .from("cv_improvements")
      .update({ suggestions: payload })
      .eq("id", rowId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update suggestion: ${error.message}`);
    return updated as CvImprovement;
  }
}

/** Reuse key: same CV content + depth + template version → serve the stored row. */
function isCurrentPayload(
  row: CvImprovement,
  contentHash: string,
  depth: SentenceRewriteDepth | BulletImproveDepth,
  templateVersion: string,
): boolean {
  if (row.template_version !== templateVersion) return false;
  const payload = row.suggestions as Partial<SentenceImprovementsPayload> | null;
  return payload?.content_hash === contentHash && payload?.depth === depth;
}

/**
 * Structural v2 check for a stored job_matches row (T5.4): old v1 results
 * and degraded rows are skipped — the missing-keywords detector only reads
 * verdicts + the requirement snapshot, never the raw JD.
 */
function toHealthMatchReport(row: { job_id: string; result: unknown }): HealthMatchReport | null {
  const result = row.result as {
    version?: unknown;
    verdicts?: unknown;
    requirements?: unknown;
  } | null;
  if (result === null || result.version !== 2) return null;
  if (!Array.isArray(result.verdicts) || !Array.isArray(result.requirements)) return null;
  return {
    jobId: row.job_id,
    verdicts: result.verdicts as RequirementVerdict[],
    requirements: result.requirements as HealthMatchReport["requirements"],
  };
}
