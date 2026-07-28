import { dataBlock, UNTRUSTED_DATA_RULE } from "./prompt.types.js";

export const templateVersion = "coach.v1";

export interface CoachContext {
  fullName: string | null;
  currentRole: string | null;
  targetRole: string | null;
  cvText: string | null; // already truncated by the caller
  pipeline: Record<string, number>; // status -> count
}

/**
 * Coach system prompt with user context injected (T9.1).
 * Context lives in the system message but inside delimited data blocks;
 * the persona/rules never interpolate raw user text.
 */
export function buildCoachSystemPrompt(ctx: CoachContext): string {
  const pipeline =
    Object.entries(ctx.pipeline)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ") || "empty";
  return (
    "You are a career coach inside a job-search app. Give concise, practical, encouraging advice " +
    "grounded in the user's actual situation below. Stay on topic: job search, CVs, interviews, " +
    "career moves. For anything off-topic, politely redirect to job-search help. " +
    "Never claim the user has experience they have not stated. " +
    UNTRUSTED_DATA_RULE +
    "\n\nUser context:\n" +
    `Name: ${ctx.fullName ?? "unknown"}\n` +
    `Current role: ${ctx.currentRole ?? "unknown"}\n` +
    `Target role: ${ctx.targetRole ?? "unknown"}\n` +
    `Pipeline: ${pipeline}\n` +
    (ctx.cvText ? `\n${dataBlock("cv_text", ctx.cvText)}` : "\n(No CV uploaded yet — suggest uploading one before giving CV-specific advice.)")
  );
}

export const compactTemplateVersion = "conversation-compact.v1";

/** Summarize older chat turns into one system-summary message (T9.1). */
export function buildCompactionMessages(turnsText: string): {
  templateVersion: string;
  messages: { role: "system" | "user"; content: string }[];
} {
  return {
    templateVersion: compactTemplateVersion,
    messages: [
      {
        role: "system",
        content:
          "Summarize this career-coaching conversation excerpt into at most 6 bullet points " +
          "capturing the user's situation, decisions made, and advice given. Plain text bullets only. " +
          UNTRUSTED_DATA_RULE,
      },
      { role: "user", content: dataBlock("conversation", turnsText) },
    ],
  };
}
