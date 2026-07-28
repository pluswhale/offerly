import { Injectable, NotFoundException } from "@nestjs/common";
import type { AiConversation, AiMessage } from "@offerly/types";
import { AiService } from "../ai/ai.service.js";
import type { ChatMessage } from "../ai/llm-provider.js";
import {
  buildCoachSystemPrompt,
  buildCompactionMessages,
} from "../ai/prompts/coach.v1.js";
import { truncateText } from "../ai/text.js";
import { SupabaseService } from "../supabase/supabase.service.js";

/** Keep at most this many raw turns; older ones are compacted (T9.1). */
const MAX_RAW_TURNS = 10;
const TURNS_TO_KEEP_ON_COMPACTION = 6;
const COACH_CV_CHARS = 4_000;

export type CoachStreamEvent =
  | { type: "token"; content: string }
  | { type: "notice"; content: string }
  | { type: "done"; compacted: boolean }
  | { type: "error"; message: string };

@Injectable()
export class CoachService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ai: AiService,
  ) {}

  async createConversation(
    userId: string,
    token: string,
    jobId?: string,
  ): Promise<AiConversation> {
    const db = this.supabase.forUser(token);
    // One ongoing coach thread per user: resume the latest conversation so
    // history persists across sessions instead of starting blank each visit.
    const { data: existing } = await db
      .from("ai_conversations")
      .select("*")
      .eq("user_id", userId)
      .eq("kind", "coach")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing as AiConversation;

    const { data: cv } = await db
      .from("cvs")
      .select("id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const { data, error } = await db
      .from("ai_conversations")
      .insert({
        user_id: userId,
        kind: "coach",
        context: {
          cv_id: (cv as { id: string } | null)?.id ?? null,
          job_id: jobId ?? null,
        },
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create conversation: ${error.message}`);
    return data as AiConversation;
  }

  /** Message history for a conversation the user owns (resumed sessions). */
  async listMessages(
    userId: string,
    token: string,
    conversationId: string,
  ): Promise<AiMessage[]> {
    const db = this.supabase.forUser(token);
    const { data: conversation } = await db
      .from("ai_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .eq("kind", "coach")
      .maybeSingle();
    if (!conversation) throw new NotFoundException("Conversation not found");

    const { data } = await db
      .from("ai_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return (data ?? []) as AiMessage[];
  }

  /**
   * Validates ownership, stores the user message, compacts old turns if the
   * conversation is long, then returns the SSE event stream. Throws (404/…)
   * before streaming starts so the controller can still send an HTTP error.
   */
  async prepareMessage(
    userId: string,
    token: string,
    conversationId: string,
    content: string,
  ): Promise<{ events: AsyncIterable<CoachStreamEvent> }> {
    const db = this.supabase.forUser(token);
    const { data: conversation } = await db
      .from("ai_conversations")
      .select("*")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .eq("kind", "coach")
      .maybeSingle();
    if (!conversation) throw new NotFoundException("Conversation not found");

    await db.from("ai_messages").insert({
      conversation_id: conversationId,
      role: "user",
      content,
    });

    const compacted = await this.compactIfNeeded(userId, token, conversationId);
    const messages = await this.buildProviderMessages(userId, token, conversationId);

    const events = this.streamReply(userId, token, conversationId, messages, compacted);
    return { events };
  }

  private async *streamReply(
    userId: string,
    token: string,
    conversationId: string,
    messages: ChatMessage[],
    compacted: boolean,
  ): AsyncIterable<CoachStreamEvent> {
    if (compacted) {
      yield {
        type: "notice",
        content: "Earlier turns of this conversation were summarized to fit the context window.",
      };
    }
    let full = "";
    try {
      const stream = this.ai.streamText({
        userId,
        operation: "coach_message",
        messages,
        maxTokens: 800,
      });
      for await (const delta of stream) {
        full += delta;
        yield { type: "token", content: delta };
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : "AI provider unavailable",
      };
      return;
    }

    const db = this.supabase.forUser(token);
    await db.from("ai_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: full,
      token_count: Math.ceil(full.length / 4),
    });
    yield { type: "done", compacted };
  }

  /**
   * Context compaction (T9.1): when the conversation grows past MAX_RAW_TURNS,
   * the older turns are summarized into a system-summary message (visible in
   * history → the user sees that compaction happened) and the raw rows removed.
   */
  private async compactIfNeeded(
    userId: string,
    token: string,
    conversationId: string,
  ): Promise<boolean> {
    const db = this.supabase.forUser(token);
    const { data } = await db
      .from("ai_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    const messages = (data ?? []) as AiMessage[];
    const rawTurns = messages.filter((m) => m.role !== "system-summary");
    if (rawTurns.length <= MAX_RAW_TURNS) return false;

    const toCompact = rawTurns.slice(0, rawTurns.length - TURNS_TO_KEEP_ON_COMPACTION);
    const turnsText = toCompact.map((m) => `${m.role}: ${m.content}`).join("\n");
    const compaction = buildCompactionMessages(turnsText);
    const summary = await this.ai.completeText({
      userId,
      operation: "coach_message",
      messages: compaction.messages,
      maxTokens: 400,
    });

    await db.from("ai_messages").insert({
      conversation_id: conversationId,
      role: "system-summary",
      content: `[Earlier conversation summarized] ${summary}`,
    });
    const ids = toCompact.map((m) => m.id);
    await db.from("ai_messages").delete().in("id", ids);
    return true;
  }

  /** System prompt with injected user context + recent turns (summaries kept). */
  private async buildProviderMessages(
    userId: string,
    token: string,
    conversationId: string,
  ): Promise<ChatMessage[]> {
    const db = this.supabase.forUser(token);

    const [{ data: profile }, { data: cv }, { data: apps }, { data: history }] =
      await Promise.all([
        db.from("profiles").select("full_name, current_role, target_role").eq("id", userId).maybeSingle(),
        db.from("cvs").select("extracted_text").eq("user_id", userId).eq("is_active", true).limit(1).maybeSingle(),
        db.from("applications").select("status").eq("user_id", userId).eq("archived", false),
        db.from("ai_messages").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
      ]);

    const pipeline: Record<string, number> = {};
    for (const row of (apps ?? []) as Array<{ status: string }>) {
      pipeline[row.status] = (pipeline[row.status] ?? 0) + 1;
    }
    const prof = profile as {
      full_name: string | null;
      current_role: string | null;
      target_role: string | null;
    } | null;
    const cvText = (cv as { extracted_text: string | null } | null)?.extracted_text;

    const system = buildCoachSystemPrompt({
      fullName: prof?.full_name ?? null,
      currentRole: prof?.current_role ?? null,
      targetRole: prof?.target_role ?? null,
      cvText: cvText ? truncateText(cvText, COACH_CV_CHARS).text : null,
      pipeline,
    });

    const messages: ChatMessage[] = [{ role: "system", content: system }];
    for (const m of ((history ?? []) as AiMessage[]).slice(-12)) {
      if (m.role === "system-summary") {
        messages.push({ role: "system", content: m.content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return messages;
  }
}
