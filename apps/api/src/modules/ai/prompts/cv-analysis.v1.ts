import { dataBlock, UNTRUSTED_DATA_RULE, type BuiltPrompt } from "./prompt.types.js";

export const templateVersion = "cv-analysis.v1";

export interface CvAnalysisSection {
  name: string;
  score: number; // 0-100
  feedback: string;
}

export interface CvAnalysisResult {
  score: number; // 0-100
  sections: CvAnalysisSection[];
  improvements: string[]; // prioritized, most impactful first
}

export function buildCvAnalysisPrompt(input: {
  cvText: string;
  depth: "basic" | "deep";
}): BuiltPrompt {
  const improvementCount = input.depth === "deep" ? "5-8" : "3";
  return {
    templateVersion,
    cacheInput: `${input.depth}:${input.cvText}`,
    messages: [
      {
        role: "system",
        content:
          "You are a CV reviewer helping job seekers improve their resume. " +
          UNTRUSTED_DATA_RULE +
          " Analyze the CV and respond ONLY with a JSON object of this exact shape: " +
          '{"score": <0-100 overall>, "sections": [{"name": <string>, "score": <0-100>, "feedback": <string>}], "improvements": [<string>]}. ' +
          `Give ${improvementCount} concrete, prioritized improvements (most impactful first). ` +
          "Score honestly: 70+ means genuinely strong, 50 means average.",
      },
      { role: "user", content: dataBlock("cv_text", input.cvText) },
    ],
  };
}

/** Manual structural validation (plan §8.4 — no schema lib needed at this size). */
export function parseCvAnalysisResult(raw: unknown): CvAnalysisResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.score !== "number" || obj.score < 0 || obj.score > 100) return null;
  if (!Array.isArray(obj.sections) || !Array.isArray(obj.improvements)) return null;
  const sections: CvAnalysisSection[] = [];
  for (const s of obj.sections) {
    if (typeof s !== "object" || s === null) return null;
    const sec = s as Record<string, unknown>;
    if (typeof sec.name !== "string" || typeof sec.score !== "number" || typeof sec.feedback !== "string") {
      return null;
    }
    sections.push({ name: sec.name, score: sec.score, feedback: sec.feedback });
  }
  if (!obj.improvements.every((i) => typeof i === "string")) return null;
  return { score: obj.score, sections, improvements: obj.improvements as string[] };
}
