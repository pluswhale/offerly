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
    const { data, error } = await db
      .from("cvs")
      .insert({
        user_id: userId,
        file_path: null,
        extracted_text: text,
        content_hash: sha256Hex(normalizeForCache(text)),
        is_active: true,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to save CV: ${error.message}`);
    await this.deactivateOthers(db, userId, (data as Cv).id);
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

    const { data, error } = await db
      .from("cvs")
      .insert({ id, user_id: userId, file_path: path, is_active: true })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create CV row: ${error.message}`);
    await this.deactivateOthers(db, userId, id);

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

  /** One active CV per user (T5.1): deactivate all others. */
  private async deactivateOthers(
    db: ReturnType<SupabaseService["forUser"]>,
    userId: string,
    keepId: string,
  ): Promise<void> {
    await db
      .from("cvs")
      .update({ is_active: false })
      .eq("user_id", userId)
      .neq("id", keepId);
  }
}
