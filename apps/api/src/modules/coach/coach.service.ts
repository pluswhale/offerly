import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  AiConversation,
  AiMessage,
  CandidateProfile,
  Job,
  JobMatch,
  JobProfile,
  JobProfileRow,
  MatchReportV2,
  UserGoals,
} from "@offerly/types";
import { env } from "../../common/env.js";
import { AiService } from "../ai/ai.service.js";
import type { ChatMessage } from "../ai/llm-provider.js";
import { buildCoachSystemPrompt as buildCoachSystemPromptV1 } from "../ai/prompts/coach.v1.js";
import {
  buildCoachProfileProjection,
  buildCoachSystemPrompt as buildCoachSystemPromptV2,
  collectChallengeEvidence,
  COACH_MANIFEST_MAX_MATCHES,
  isEvidenceChallenge,
  type CoachMatchSummary,
} from "../ai/prompts/coach.v2.js";
import { conversationCompactV1 } from "../ai/prompts/conversation-compact.v1.js";
import { candidateProfileSchema } from "../ai/schemas/candidate-profile.schema.js";
import { truncateText } from "../ai/text.js";
import { SupabaseService } from "../supabase/supabase.service.js";

/** Keep at most this many raw turns; older ones are compacted (T9.1). */
const MAX_RAW_TURNS = 10;
const TURNS_TO_KEEP_ON_COMPACTION = 6;
const COACH_CV_CHARS = 4_000;
/** Staleness threshold for the pipeline manifest (spec 003 §FR-11). */
const STALE_APPLICATION_DAYS = 14;
/** Cap on the last-advice echo inside the manifest. */
const LAST_ADVICE_CHARS = 600;
/** Recent matches scanned for the top-by-score manifest selection. */
const MATCH_SCAN_LIMIT = 20;

export type CoachStreamEvent =
  | { type: "token"; content: string }
  | { type: "notice"; content: string }
  | { type: "done"; compacted: boolean }
  | { type: "error"; message: string };

/** Selected template: coach.v2 by default, coach.v1 behind the rollback flag. */
function coachTemplateVersion(): "v1" | "v2" {
  return env("COACH_TEMPLATE_VERSION", "v2") === "v1" ? "v1" : "v2";
}

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
    const messages = await this.buildProviderMessages(userId, token, conversationId, content);

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
    const summary = await this.ai.completeText({
      userId,
      operation: "coach_message",
      messages: [
        { role: "system", content: conversationCompactV1.buildSystemPrompt({ turnsText }) },
        { role: "user", content: conversationCompactV1.buildUserMessage({ turnsText }) },
      ],
      maxTokens: conversationCompactV1.maxTokens,
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
    userMessage: string,
  ): Promise<ChatMessage[]> {
    // Rollback flag (spec 003 T4.3): COACH_TEMPLATE_VERSION=v1 restores the
    // raw-CV coach without a deploy.
    const system =
      coachTemplateVersion() === "v1"
        ? await this.buildV1SystemPrompt(userId, token, conversationId)
        : await this.buildV2SystemPrompt(userId, token, conversationId, userMessage);

    const db = this.supabase.forUser(token);
    const { data: history } = await db
      .from("ai_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

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

  /** coach.v1 path (rollback): truncated raw CV text in the system prompt. */
  private async buildV1SystemPrompt(
    userId: string,
    token: string,
    _conversationId: string,
  ): Promise<string> {
    const db = this.supabase.forUser(token);
    const [{ data: profile }, { data: cv }, { data: apps }] = await Promise.all([
      db.from("profiles").select("full_name, current_role, target_role").eq("id", userId).maybeSingle(),
      db.from("cvs").select("extracted_text").eq("user_id", userId).eq("is_active", true).limit(1).maybeSingle(),
      db.from("applications").select("status").eq("user_id", userId).eq("archived", false),
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

    return buildCoachSystemPromptV1({
      fullName: prof?.full_name ?? null,
      currentRole: prof?.current_role ?? null,
      targetRole: prof?.target_role ?? null,
      cvText: cvText ? truncateText(cvText, COACH_CV_CHARS).text : null,
      pipeline,
    });
  }

  /**
   * coach.v2 context manifest (spec 003 §FR-11, T4.3): user profile + goals,
   * compact Candidate Profile projection (values, no evidence), top-5 match
   * summaries, pipeline counts/staleness, last advice. Raw CV text is never
   * fetched — the cvs table is not queried on this path.
   */
  private async buildV2SystemPrompt(
    userId: string,
    token: string,
    conversationId: string,
    userMessage: string,
  ): Promise<string> {
    const db = this.supabase.forUser(token);

    const [{ data: profile }, { data: candidateRow }, { data: matchRows }, { data: apps }, { data: history }] =
      await Promise.all([
        db.from("profiles").select("full_name, current_role, target_role, user_goals").eq("id", userId).maybeSingle(),
        db.from("candidate_profiles").select("profile").eq("user_id", userId).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("job_matches").select("job_id, score, result").eq("user_id", userId).order("created_at", { ascending: false }).limit(MATCH_SCAN_LIMIT),
        db.from("applications").select("status, updated_at").eq("user_id", userId).eq("archived", false),
        db.from("ai_messages").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
      ]);

    const prof = profile as {
      full_name: string | null;
      current_role: string | null;
      target_role: string | null;
      user_goals: UserGoals | null;
    } | null;

    // Compact profile projection; an unparsable stored profile degrades to
    // the "no profile yet" note rather than poisoning the prompt.
    let candidate: CandidateProfile | null = null;
    if (candidateRow) {
      const parsed = candidateProfileSchema.safeParse(
        (candidateRow as { profile: unknown }).profile,
      );
      if (parsed.success) candidate = parsed.data;
    }

    const matches = await this.summarizeTopMatches(
      token,
      ((matchRows ?? []) as Array<Pick<JobMatch, "job_id" | "score" | "result">>).slice(
        0,
        MATCH_SCAN_LIMIT,
      ),
    );

    const pipeline: Record<string, number> = {};
    let staleApplications = 0;
    const staleBefore = Date.now() - STALE_APPLICATION_DAYS * 24 * 60 * 60 * 1000;
    for (const row of (apps ?? []) as Array<{ status: string; updated_at: string }>) {
      pipeline[row.status] = (pipeline[row.status] ?? 0) + 1;
      if (new Date(row.updated_at).getTime() < staleBefore) staleApplications += 1;
    }

    const historyRows = (history ?? []) as AiMessage[];
    const lastAssistant = [...historyRows].reverse().find((m) => m.role === "assistant");

    // Evidence drill-down (spec §FR-11): only when the user challenges a
    // claim, and only for the profile facts they actually mentioned.
    const evidence =
      candidate !== null && isEvidenceChallenge(userMessage)
        ? collectChallengeEvidence(candidate, userMessage)
        : [];

    return buildCoachSystemPromptV2({
      fullName: prof?.full_name ?? null,
      currentRole: prof?.current_role ?? null,
      targetRole: prof?.target_role ?? null,
      goals: prof?.user_goals ?? null,
      profile: candidate !== null ? buildCoachProfileProjection(candidate) : null,
      matches,
      pipeline,
      staleApplications,
      lastAdvice: lastAssistant
        ? truncateText(lastAssistant.content, LAST_ADVICE_CHARS).text
        : null,
      evidence,
    });
  }

  /**
   * Top-5 matches by score with must-have gap summaries (spec §FR-11).
   * Requirement texts come from the job profile (already extracted for the
   * match) — verdicts store ids only.
   */
  private async summarizeTopMatches(
    token: string,
    rows: Array<Pick<JobMatch, "job_id" | "score" | "result">>,
  ): Promise<CoachMatchSummary[]> {
    const top = [...rows].sort((a, b) => b.score - a.score).slice(0, COACH_MANIFEST_MAX_MATCHES);
    if (top.length === 0) return [];

    const db = this.supabase.forUser(token);
    const jobIds = top.map((row) => row.job_id);
    const [{ data: jobs }, { data: jobProfiles }] = await Promise.all([
      db.from("jobs").select("id, title, company").in("id", jobIds),
      db.from("job_profiles").select("job_id, profile").in("job_id", jobIds),
    ]);

    const jobById = new Map(
      ((jobs ?? []) as Array<Pick<Job, "id" | "title" | "company">>).map((job) => [job.id, job]),
    );
    const requirementTextByJob = new Map<string, Map<string, { text: string; importance: string }>>();
    for (const row of (jobProfiles ?? []) as Array<Pick<JobProfileRow, "job_id" | "profile">>) {
      const requirements = (row.profile as Partial<JobProfile> | null)?.requirements ?? [];
      const byId = new Map<string, { text: string; importance: string }>();
      for (const req of requirements) {
        byId.set(req.id, {
          text: req.text.status === "stated" && req.text.value !== null ? req.text.value : req.id,
          importance: req.importance,
        });
      }
      requirementTextByJob.set(row.job_id, byId);
    }

    return top.map((row) => {
      const result = row.result as Partial<MatchReportV2> | null;
      const requirements = requirementTextByJob.get(row.job_id);
      const gaps: string[] = [];
      for (const verdict of result?.verdicts ?? []) {
        if (verdict.verdict !== "missing" && verdict.verdict !== "partial") continue;
        const requirement = requirements?.get(verdict.requirement_id);
        // Gaps are must-have failures; nice-to-haves are not coaching gaps.
        if (requirement && requirement.importance !== "must_have") continue;
        gaps.push(
          `${requirement?.text ?? verdict.requirement_id} (${verdict.verdict})`,
        );
      }
      const job = jobById.get(row.job_id);
      return {
        jobTitle: job?.title ?? null,
        company: job?.company ?? null,
        score: result?.score ?? row.score,
        lowConfidence: result?.low_confidence ?? false,
        gaps,
      };
    });
  }
}
