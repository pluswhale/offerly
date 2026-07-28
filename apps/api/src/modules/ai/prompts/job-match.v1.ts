import { dataBlock, UNTRUSTED_DATA_RULE, type BuiltPrompt } from "./prompt.types.js";

export const templateVersion = "job-match.v1";

export interface JobMatchResult {
  score: number; // 0-100
  strengths: string[];
  gaps: string[];
  recommendations: string[]; // 2-3 actionable items
}

export function buildJobMatchPrompt(input: {
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
          "You are a job-fit analyst. Compare the candidate's CV against the job description. " +
          UNTRUSTED_DATA_RULE +
          " Respond ONLY with a JSON object of this exact shape: " +
          '{"score": <0-100>, "strengths": [<string>], "gaps": [<string>], "recommendations": [<string>]}. ' +
          "Base every point strictly on evidence in the CV; never assume experience that is not stated. " +
          "Gaps are requirements in the job description the CV does not demonstrate. " +
          "Give 2-3 concrete recommendations to close the most important gaps.",
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

export function parseJobMatchResult(raw: unknown): JobMatchResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.score !== "number" || obj.score < 0 || obj.score > 100) return null;
  const lists = [obj.strengths, obj.gaps, obj.recommendations];
  if (!lists.every((l) => Array.isArray(l) && l.every((i) => typeof i === "string"))) {
    return null;
  }
  return {
    score: obj.score,
    strengths: obj.strengths as string[],
    gaps: obj.gaps as string[],
    recommendations: obj.recommendations as string[],
  };
}
