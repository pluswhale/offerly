import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Cv, CvAnalysis } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import {
  buildCvAnalysisPrompt,
  parseCvAnalysisResult,
  type CvAnalysisResult,
} from "../ai/prompts/cv-analysis.v1.js";
import { normalizeForCache, sha256Hex, truncateText } from "../ai/text.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { extractText } from "./extract-text.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB (plan §9)
const ALLOWED_CONTENT_TYPES = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
]);
const MAX_CV_CHARS = 12_000; // input token cap (plan §8.4)
const MIN_EXTRACTED_CHARS = 50; // below this a PDF is treated as scanned

export interface SignedUpload {
  cv: Cv;
  signed_url: string;
  path: string;
}

@Injectable()
export class CvsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
  ) {}

  async list(userId: string, token: string): Promise<Cv[]> {
    const db = this.supabase.forUser(token);
    const { data, error } = await db
      .from("cvs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list CVs: ${error.message}`);
    return (data ?? []) as Cv[];
  }

  async getOwned(userId: string, token: string, cvId: string): Promise<Cv> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("cvs")
      .select("*")
      .eq("id", cvId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) throw new NotFoundException("CV not found");
    return data as Cv;
  }

  /** The user's active CV, or null (match/apply prompt for upload in that case). */
  async getActive(userId: string, token: string): Promise<Cv | null> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("cvs")
      .select("*")
      .eq("user_id", userId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    return (data as Cv | null) ?? null;
  }

  /** Paste flow: text stored directly, hash computed, becomes the active CV. */
  async createFromText(userId: string, token: string, text: string): Promise<Cv> {
    const db = this.supabase.forUser(token);
    // Deactivate first: the one-active-per-user unique index rejects an
    // insert while another row is still active.
    await this.deactivateOthers(db, userId);
    const { data, error } = await db
      .from("cvs")
      .insert({
        user_id: userId,
        name: "Pasted CV",
        file_path: null,
        extracted_text: text,
        content_hash: sha256Hex(normalizeForCache(text)),
        is_active: true,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to save CV: ${error.message}`);
    return data as Cv;
  }

  /**
   * Upload flow step 1 (plan §9): validate type/size, create the cvs row,
   * hand back a signed upload URL for the private 'cvs' bucket.
   */
  async createSignedUpload(
    userId: string,
    token: string,
    input: { filename: string; contentType: string; sizeBytes: number },
  ): Promise<SignedUpload> {
    const ext = ALLOWED_CONTENT_TYPES.get(input.contentType);
    if (!ext) {
      throw new UnprocessableEntityException({
        message: "Only PDF and DOCX files are supported",
        code: "unsupported_file_type",
      });
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) {
      throw new UnprocessableEntityException({
        message: "File must be 5 MB or smaller",
        code: "file_too_large",
      });
    }

    const db = this.supabase.forUser(token);
    const id = randomUUID();
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${userId}/${id}-${safeName}`;

    // Deactivate first (one-active-per-user unique index), then insert active.
    await this.deactivateOthers(db, userId);
    const { data, error } = await db
      .from("cvs")
      .insert({ id, user_id: userId, name: input.filename, file_path: path, is_active: true })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create CV row: ${error.message}`);

    const { data: signed, error: signError } = await db.storage
      .from("cvs")
      .createSignedUploadUrl(path);
    if (signError || !signed) {
      throw new Error(`Failed to create signed upload URL: ${signError?.message}`);
    }
    return { cv: data as Cv, signed_url: signed.signedUrl, path };
  }

  /**
   * Upload flow step 2: download the file, extract text, store it.
   * Scanned PDFs (no text layer) → 422 with a paste-fallback message (T5.1).
   */
  async confirmUpload(userId: string, token: string, cvId: string): Promise<Cv> {
    const cv = await this.getOwned(userId, token, cvId);
    if (!cv.file_path) {
      throw new UnprocessableEntityException("This CV has no uploaded file");
    }
    const db = this.supabase.forUser(token);
    const { data: blob, error } = await db.storage.from("cvs").download(cv.file_path);
    if (error || !blob) {
      throw new NotFoundException("Uploaded file not found — upload it first");
    }
    const buffer = Buffer.from(await blob.arrayBuffer());

    let text: string;
    try {
      text = await extractText(buffer, cv.file_path);
    } catch (err) {
      throw new UnprocessableEntityException({
        message: `Could not read the file (${err instanceof Error ? err.message : "parse error"})`,
        code: "extraction_failed",
      });
    }

    if (text.trim().length < MIN_EXTRACTED_CHARS) {
      throw new UnprocessableEntityException({
        message:
          "This PDF has no extractable text (it looks like a scan). Paste your CV text instead.",
        code: "no_text_layer",
      });
    }

    const { data, error: updateError } = await db
      .from("cvs")
      .update({
        extracted_text: text,
        content_hash: sha256Hex(normalizeForCache(text)),
      })
      .eq("id", cvId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (updateError) throw new Error(`Failed to store extracted text: ${updateError.message}`);
    return data as Cv;
  }

  /**
   * POST /cvs/:id/analyze (T5.3). Cached on CV content hash — re-analyzing an
   * unchanged CV is a cache hit and free. Truncation is reported in the result.
   */
  async analyze(
    userId: string,
    token: string,
    cvId: string,
    depth: "basic" | "deep",
  ): Promise<CvAnalysis> {
    const cv = await this.getOwned(userId, token, cvId);
    if (!cv.extracted_text || !cv.content_hash) {
      throw new UnprocessableEntityException({
        message: "This CV has no text yet — upload a file or paste the text first",
        code: "no_text",
      });
    }

    const truncated = truncateText(cv.extracted_text, MAX_CV_CHARS);
    const prompt = buildCvAnalysisPrompt({ cvText: truncated.text, depth });
    const result = await this.ai.generateJson<CvAnalysisResult>({
      userId,
      operation: "cv_analysis",
      prompt,
      maxTokens: depth === "deep" ? 2500 : 1500,
      parse: parseCvAnalysisResult,
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
          template_version: prompt.templateVersion,
        },
        depth,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to store analysis: ${error.message}`);
    return data as CvAnalysis;
  }

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
   * PATCH /cvs/:id (T12.1): rename and/or activate. Activation deactivates
   * the others first so the one-active unique index is never violated.
   */
  async update(
    userId: string,
    token: string,
    cvId: string,
    patch: { name?: string; is_active?: boolean },
  ): Promise<Cv> {
    const cv = await this.getOwned(userId, token, cvId);

    const updates: { name?: string; is_active?: boolean } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 120) {
        throw new UnprocessableEntityException({
          message: "CV name must be 1–120 characters",
          code: "invalid_name",
        });
      }
      updates.name = name;
    }
    if (patch.is_active !== undefined) updates.is_active = patch.is_active;
    if (Object.keys(updates).length === 0) return cv;

    const db = this.supabase.forUser(token);
    if (updates.is_active === true) await this.deactivateOthers(db, userId, cvId);
    const { data, error } = await db
      .from("cvs")
      .update(updates)
      .eq("id", cvId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update CV: ${error.message}`);
    return data as Cv;
  }

  /**
   * DELETE /cvs/:id (T12.1). cv_analyses and job_matches cascade on delete;
   * the storage file is removed best-effort. Deleting the active CV
   * intentionally leaves no active CV.
   */
  async remove(userId: string, token: string, cvId: string): Promise<void> {
    const cv = await this.getOwned(userId, token, cvId);
    const db = this.supabase.forUser(token);
    if (cv.file_path) {
      const { error } = await db.storage.from("cvs").remove([cv.file_path]);
      if (error) console.warn(`Failed to delete CV file ${cv.file_path}: ${error.message}`);
    }
    const { error } = await db.from("cvs").delete().eq("id", cvId).eq("user_id", userId);
    if (error) throw new Error(`Failed to delete CV: ${error.message}`);
  }

  /** One active CV per user (T5.1): deactivate all others (or all, pre-insert). */
  private async deactivateOthers(
    db: ReturnType<SupabaseService["forUser"]>,
    userId: string,
    keepId?: string,
  ): Promise<void> {
    let query = db.from("cvs").update({ is_active: false }).eq("user_id", userId);
    if (keepId) query = query.neq("id", keepId);
    await query;
  }
}
