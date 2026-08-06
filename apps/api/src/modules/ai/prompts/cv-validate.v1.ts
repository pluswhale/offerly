import {
  cvValidateOutputSchema,
  type CvValidateOutput,
} from "../schemas/cv-validate.schema.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

/**
 * One item sent to S3 adjudication (spec 003 §FR-1, T2.3): a flagged or
 * low-confidence Evidenced leaf plus the CV excerpt (±300 chars around its
 * evidence span) the decision must be grounded in — never the full CV.
 */
export interface CvValidateItem {
  /** Verifier-style field path, e.g. "skills.databases[0]". */
  path: string;
  /** Why it was flagged: evidence_unverified | low_confidence | consistency flags. */
  flag: string;
  value: unknown;
  /** The suspect quote; null when the item never had evidence. */
  evidence: string | null;
  /** CV excerpt around the evidence span (or the headline region). */
  excerpt: string;
}

export interface CvValidateInput {
  items: CvValidateItem[];
}

const SYSTEM_PROMPT = `You adjudicate suspicious items in a structured Candidate Profile extracted from a CV. You receive ONLY the flagged items, each with a short excerpt of the CV around the passage the value supposedly came from. Respond with ONLY a JSON object, no prose, no code fences.

For EACH item decide exactly one action:
- "keep": the excerpt supports the value as stated.
- "correct": the excerpt supports a DIFFERENT value. Provide "corrected": {"value": <fixed value>, "evidence": <VERBATIM quote copied character-for-character from the excerpt>}.
- "drop": the excerpt does not support the value and no honest correction exists. Dropping is always preferable to guessing.

HARD RULES:
1. Ground every decision in the item's excerpt alone. If the excerpt does not contain the fact, the fact does not exist.
2. Never invent values, dates, skills, or evidence. A corrected evidence quote must be a verbatim span of the excerpt.
3. Adjudicate every item exactly once, echoing its "path" unchanged.
4. "reason" is one short sentence citing what the excerpt does or does not say.

OUTPUT SHAPE:
{"adjudications": [{"path": string, "action": "keep"|"correct"|"drop", "corrected"?: {"value": unknown, "evidence": string}, "reason": string}]}

${UNTRUSTED_DATA_RULE}`;

/**
 * S3 — conditional adjudication of flagged/low-confidence items (spec 003
 * §FR-1/§FR-10, T2.3). Strong model tier: accuracy where it matters. Cached
 * per flagged-item set — the same set of suspect paths/values never costs
 * twice. Skipped entirely by the caller when nothing is flagged.
 */
export const cvValidateV1: PromptTemplate<CvValidateInput, CvValidateOutput> = {
  templateVersion: "cv-validate.v1",
  buildSystemPrompt: () => SYSTEM_PROMPT,
  buildUserMessage: (input) =>
    input.items
      .map((item, i) => {
        const header = `Item ${i + 1}\npath: ${item.path}\nflag: ${item.flag}\nvalue: ${JSON.stringify(
          item.value ?? null,
        )}\nsuspect evidence: ${JSON.stringify(item.evidence ?? null)}\nexcerpt:`;
        return `${header}\n${dataBlock("cv_excerpt", item.excerpt)}`;
      })
      .join("\n\n"),
  schema: cvValidateOutputSchema,
  validate: (raw) => {
    const parsed = cvValidateOutputSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  // Cache identity = the flagged-item set (path + flag + value), not the
  // excerpts: the same suspects adjudicate the same way.
  cacheInput: (input) =>
    JSON.stringify(
      input.items
        .map((item) => [item.path, item.flag, item.value ?? null] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ),
  maxTokens: 2048,
  modelTier: "strong",
};
