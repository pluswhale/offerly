import type { CandidateProfile } from "@offerly/types";
import { candidateProfileSchema } from "../schemas/candidate-profile.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export interface CvExtractInput {
  /** CV text, already truncated by the caller (see profile-extraction.ts). */
  cvText: string;
  /** CV content hash — the cache identity for this extraction. */
  contentHash: string;
  /** True when the CV exceeded the extraction cap and was truncated. */
  truncated: boolean;
}

const SYSTEM_PROMPT = `You extract a structured Candidate Profile from a CV. Respond with ONLY a JSON object, no prose, no code fences.

HARD RULES — violating any of them makes the output unusable:
1. Emit the COMPLETE profile: every field below must be present explicitly. Omitting a field is an error.
2. Evidence or nothing: every stated fact must carry a VERBATIM quote copied character-for-character from the CV (you may trim leading/trailing whitespace). If the CV does not say it, you do not say it.
3. Missing information is UNKNOWN, written exactly as {"value":null,"status":"unknown","confidence":0,"evidence":null}. Never infer, extrapolate, or invent. When unsure between two readings, prefer UNKNOWN.
4. total_years_experience must be derived from the dated roles only (quote the dates as evidence, e.g. "2018 - present"). If roles have no dates, it is UNKNOWN.
5. A category the CV never mentions is an EMPTY ARRAY (e.g. "databases": []). Never pad arrays with unmentioned skills.
6. Confidence is your own 0-1 certainty that the quote supports the value; it will be verified and clamped downstream.

EVIDENCED LEAF SHAPE — every leaf fact is:
{"value": <T|null>, "status": "stated"|"unknown", "confidence": <0-1>, "evidence": <verbatim quote|null>}

TOP-LEVEL SHAPE:
{
  "headline": {"title": Evidenced<string>, "seniority": Evidenced<"junior"|"mid"|"senior"|"staff"|"lead"|"manager"|"executive">, "total_years_experience": Evidenced<number>},
  "roles": [{"title", "company", "start", "end", "industry", "scope" — all Evidenced<string>, "is_current": boolean (true iff end is "present"/equivalent)}],
  "skills": {"programming_languages": [], "frameworks": [], "cloud_platforms": [], "databases": [], "devops_tools": [], "other_technologies": [], "soft_skills": []} — each item Evidenced<string> with optional "years" (number) and "recency" (last role it appears in) when the CV states them,
  "experience": {"industries": [], "domains": [] — arrays of Evidenced<string>; "team_sizes_managed": Evidenced<number>, "leadership": Evidenced<boolean>, "leadership_scope": Evidenced<string>, "management": Evidenced<boolean>, "management_scope": Evidenced<string>},
  "education": [{"degree", "institution": Evidenced<string>, "year": Evidenced<number>}],
  "certifications": [{"name", "issuer": Evidenced<string>, "year": Evidenced<number>}],
  "languages": [{"language": Evidenced<string>, "level": Evidenced<"native"|"fluent"|"professional"|"basic">}],
  "location": {"current": Evidenced<string>, "work_authorization": [] of Evidenced<string>, "remote_preference": Evidenced<"onsite"|"hybrid"|"remote"|"any">}
}
Do not emit "summary_quality" — it is derived later, not extracted.

${UNTRUSTED_DATA_RULE}`;

/**
 * S1 — CV text → raw Candidate Profile (spec 003 §FR-2/§FR-10).
 * Cached by the CV content hash: the same CV text never costs twice.
 */
export const cvExtractV1: PromptTemplate<CvExtractInput, CandidateProfile> = {
  templateVersion: "cv-extract.v1",
  buildSystemPrompt: () => SYSTEM_PROMPT,
  buildUserMessage: (input) => {
    const note = input.truncated
      ? "Note: the CV text below was truncated to fit the analysis limit; extract only from what is present.\n\n"
      : "";
    return note + dataBlock("cv", input.cvText);
  },
  schema: candidateProfileSchema,
  validate: (raw) => {
    const parsed = candidateProfileSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  cacheInput: (input) => input.contentHash,
  maxTokens: 4096,
  modelTier: "cheap",
};
