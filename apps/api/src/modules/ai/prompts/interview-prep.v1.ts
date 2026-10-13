import { dataBlock, UNTRUSTED_DATA_RULE, type BuiltPrompt } from "./prompt.types.js";

export const templateVersion = "interview-prep.v1";

const MIN_QUESTIONS = 4;
const MAX_QUESTIONS = 8;
const MIN_TALKING_POINTS = 2;
const MAX_TALKING_POINTS = 3;
const QUESTIONS_TO_ASK = 2;

export interface InterviewPrepQuestion {
  question: string;
  why: string; // why this role/JD makes the question likely
  talking_points: string[]; // 2-3, grounded in the CV only
}

export interface InterviewPrepResult {
  questions: InterviewPrepQuestion[];
  questions_to_ask: string[];
  gaps_flagged: string[]; // JD requirements the CV does not evidence
}

export function buildInterviewPrepPrompt(input: {
  cvText: string;
  jdText: string;
  title: string;
  company: string | null;
}): BuiltPrompt {
  return {
    templateVersion,
    cacheInput: `${input.cvText}\n---\n${input.jdText}`,
    messages: [
      {
        role: "system",
        content:
          "You are an interview coach. Predict the questions this employer is likely to ask " +
          "for the role below, and prepare the candidate using only their own CV. " +
          UNTRUSTED_DATA_RULE +
          " HONESTY RULE (absolute): every talking point must reference experience, skills or " +
          "achievements actually stated in the CV — never invent, exaggerate or imply anything " +
          "else. Where the job requires something the CV does not evidence, do not fake a " +
          "talking point: list it in gaps_flagged instead. " +
          "Respond ONLY with a JSON object of this exact shape: " +
          '{"questions": [{"question": <string>, "why": <string>, "talking_points": [<string>]}], ' +
          '"questions_to_ask": [<string>], "gaps_flagged": [<string>]}. ' +
          `Return exactly 6 questions, each with ${MIN_TALKING_POINTS}-${MAX_TALKING_POINTS} talking points ` +
          `and a "why" explaining what in the job description makes it likely. ` +
          `Return exactly ${QUESTIONS_TO_ASK} sharp questions for the candidate to ask the interviewer.`,
      },
      {
        role: "user",
        content:
          `Role: ${input.title}${input.company ? ` at ${input.company}` : ""}\n\n` +
          `${dataBlock("cv_text", input.cvText)}\n\n${dataBlock("job_description", input.jdText)}`,
      },
    ],
  };
}

export function parseInterviewPrepResult(raw: unknown): InterviewPrepResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || !Array.isArray(obj.questions_to_ask)) return null;
  if (!Array.isArray(obj.gaps_flagged)) return null;
  if (obj.questions.length < MIN_QUESTIONS || obj.questions.length > MAX_QUESTIONS) return null;
  if (obj.questions_to_ask.length !== QUESTIONS_TO_ASK) return null;

  const questions: InterviewPrepQuestion[] = [];
  for (const q of obj.questions) {
    if (typeof q !== "object" || q === null) return null;
    const item = q as Record<string, unknown>;
    if (!isNonEmptyString(item.question) || !isNonEmptyString(item.why)) return null;
    if (!Array.isArray(item.talking_points)) return null;
    if (
      item.talking_points.length < MIN_TALKING_POINTS ||
      item.talking_points.length > MAX_TALKING_POINTS
    ) {
      return null;
    }
    const talkingPoints: string[] = [];
    for (const point of item.talking_points) {
      if (!isNonEmptyString(point)) return null;
      talkingPoints.push(point);
    }
    questions.push({ question: item.question, why: item.why, talking_points: talkingPoints });
  }

  const questionsToAsk: string[] = [];
  for (const q of obj.questions_to_ask) {
    if (!isNonEmptyString(q)) return null;
    questionsToAsk.push(q);
  }

  const gaps: string[] = [];
  for (const gap of obj.gaps_flagged) {
    if (typeof gap !== "string") return null;
    gaps.push(gap);
  }

  return { questions, questions_to_ask: questionsToAsk, gaps_flagged: gaps };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
