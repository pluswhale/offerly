import type { JobProfile } from "@offerly/types";
import { jobProfileSchema } from "../schemas/job-profile.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export interface JdExtractInput {
  /** JD text, already truncated by the caller (see job-extraction.ts). */
  jdText: string;
  /** Job content hash — the cache identity for this extraction. */
  contentHash: string;
  /** True when the JD exceeded the extraction cap and was truncated. */
  truncated: boolean;
}

const SYSTEM_PROMPT = `You convert a job description into a structured Job Profile. Respond with ONLY a JSON object, no prose, no code fences.

HARD RULES — violating any of them makes the output unusable:
1. Emit the COMPLETE profile: every field below must be present explicitly. Omitting a field is an error.
2. Evidence or nothing: every stated fact must carry a VERBATIM quote copied character-for-character from the job description (you may trim leading/trailing whitespace). If the job description does not say it, you do not say it.
3. Missing information is UNKNOWN, written exactly as {"value":null,"status":"unknown","confidence":0,"evidence":null}. Never infer, extrapolate, or invent. Perks, benefits, or requirements not in the text must NEVER appear anywhere in the output. When unsure between two readings, prefer UNKNOWN.
4. remote_policy is "onsite"|"hybrid"|"remote" only when the text states it (quote it); otherwise it is UNKNOWN with value null — do not guess it from the location or company culture.
5. A category the job description never mentions is an EMPTY ARRAY (e.g. "languages": []).
6. Confidence is your own 0-1 certainty that the quote supports the value; it will be verified and clamped downstream.

EVIDENCED LEAF SHAPE — every leaf fact is:
{"value": <T|null>, "status": "stated"|"unknown", "confidence": <0-1>, "evidence": <verbatim quote|null>}

TOP-LEVEL SHAPE:
{
  "required_skills": [] of Evidenced<string>,   — skills the JD marks as required/must-have
  "preferred_skills": [] of Evidenced<string>,  — skills the JD marks as nice-to-have/preferred
  "min_years_experience": Evidenced<number>,    — the minimum years explicitly required, as a number
  "industry": Evidenced<string>,
  "location": Evidenced<string>,
  "remote_policy": Evidenced<"onsite"|"hybrid"|"remote"|"unknown">,
  "languages": [] of Evidenced<string>,
  "education_requirements": [] of Evidenced<string>,
  "requirements": [
    {
      "id": "req-1",                            — sequential: req-1, req-2, ...
      "text": Evidenced<string>,                — the requirement, quoting the JD verbatim
      "category": "skill"|"experience"|"industry"|"location"|"language"|"education"|"other",
      "importance": "must_have"|"nice_to_have"  — must_have when the JD frames it as required; nice_to_have when preferred/optional
    }
  ]
}
"requirements" is the normalized flat list of every distinct requirement the JD states — split merged bullet lines into one entry per distinct requirement, keep each entry's evidence quote verbatim from the JD.

${UNTRUSTED_DATA_RULE}`;

/**
 * JD text → structured Job Profile (spec 003 §FR-5/§FR-10). Cached by the
 * job content hash: the same JD text never costs twice, even across users —
 * the llm_cache is global and JD text is not user-private. Job Profiles are
 * still stored per job (per user); only the LLM call is shared.
 */
export const jdExtractV1: PromptTemplate<JdExtractInput, JobProfile> = {
  templateVersion: "jd-extract.v1",
  buildSystemPrompt: () => SYSTEM_PROMPT,
  buildUserMessage: (input) => {
    const note = input.truncated
      ? "Note: the job description below was truncated to fit the analysis limit; extract only from what is present.\n\n"
      : "";
    return note + dataBlock("job_description", input.jdText);
  },
  schema: jobProfileSchema,
  validate: (raw) => {
    const parsed = jobProfileSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  cacheInput: (input) => input.contentHash,
  maxTokens: 4096,
  modelTier: "cheap",
};
