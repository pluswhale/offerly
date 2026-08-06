import type {
  CandidateProfile,
  EvidencedStatus,
  RequirementCategory,
  RequirementImportance,
} from "@offerly/types";
import { getEvidencedAtPath } from "../profile-paths.js";
import {
  matchRequirementsOutputSchema,
  type MatchRequirementsOutput,
} from "../schemas/match-requirements.schema.js";
import { sha256Hex } from "../text.js";
import {
  dataBlock,
  UNTRUSTED_DATA_RULE,
  type PromptTemplate,
} from "./prompt.types.js";

export const MATCH_REQUIREMENTS_TEMPLATE_VERSION = "match-requirements.v1";

/**
 * One fact in the compact profile projection (T3.3): the verifier-style field
 * path it lives at (this is what verdicts cite in candidate_evidence), its
 * value/status, and the evidence quote it was extracted from. Scalars are
 * always present — an "unknown" status is how the model learns the profile is
 * silent on that space; array members appear only when stated (an empty
 * section means the CV never mentions it).
 */
export interface ProjectedFact {
  /** Verifier-style path into the full Candidate Profile, e.g. "skills.devops_tools[1]". */
  path: string;
  value: unknown;
  status: EvidencedStatus;
  evidence: string | null;
}

export interface ProjectedSkill extends ProjectedFact {
  years?: number | null;
  recency?: string | null;
}

/**
 * The compact, evidence-bearing profile subset the model sees (spec §FR-10):
 * headline, skills, industries/domains, experience scalars, education,
 * certifications, languages, location. Roles and full CV text are deliberately
 * NOT shipped — the LLM cannot reference what it was never shown (spec §FR-7).
 */
export interface ProfileProjection {
  headline: ProjectedFact[];
  skills: ProjectedSkill[];
  industries: ProjectedFact[];
  domains: ProjectedFact[];
  experience: ProjectedFact[];
  education: ProjectedFact[];
  certifications: ProjectedFact[];
  languages: ProjectedFact[];
  location: ProjectedFact[];
}

/** One unresolved requirement, flattened for the model. */
export interface MatchRequirementItem {
  id: string;
  text: string;
  category: RequirementCategory;
  importance: RequirementImportance;
}

export interface MatchRequirementsInput {
  profile: ProfileProjection;
  requirements: MatchRequirementItem[];
}

/**
 * Validation context for the template instance (never sent to the model):
 * cited paths are checked against the FULL profile, and the output must cover
 * every requirement id exactly once.
 */
export interface MatchRequirementsContext {
  profile: CandidateProfile;
  requirementIds: readonly string[];
}

const SYSTEM_PROMPT = `You classify how well a candidate satisfies job requirements. You receive a COMPACT PROJECTION of the candidate's validated profile — every fact carries the field path it lives at, its status, and the evidence quote it came from — plus a list of requirements. Respond with ONLY a JSON object, no prose, no code fences.

For EACH requirement emit exactly one verdict:
- "match": the profile evidences that the requirement is met, directly or by clear semantic equivalence (e.g. "built GitHub Actions pipelines" evidences "CI/CD pipelines").
- "partial": part of the requirement is evidenced; the rest is unaddressed or weaker than demanded (e.g. right technology, less depth).
- "unknown": the profile is SILENT on the requirement's space — the relevant fields have status "unknown" or the relevant section is empty. You do NOT claim the candidate lacks it.
- "missing": the profile POSITIVELY covers the requirement's space AND the requirement is not met — e.g. languages English/Russian are stated and German is required, or 2 years of experience are stated and 5 are required. A negative claim needs positive evidence, same as any other claim. NEVER emit "missing" from silence.

HARD RULES — violating any of them makes the output unusable:
1. candidate_evidence lists ONLY field paths that appear in the provided profile projection (e.g. "skills.devops_tools[1]"). Anything absent from the projection does not exist. "unknown" verdicts cite NO evidence; "missing" verdicts MUST cite the positively covering fields.
2. reasoning is one or two sentences, grounded in the cited evidence.
3. Never claim skills, experience, or facts that are not present in the provided profile. The raw CV is not available to you — the projection is the whole truth.
4. Emit exactly one verdict per requirement, echoing its "id" unchanged — no missing ids, no extras, no duplicates.

OUTPUT SHAPE:
{"verdicts": [{"requirement_id": string, "verdict": "match"|"partial"|"unknown"|"missing", "confidence": <0-1>, "candidate_evidence": [profile field paths], "reasoning": string}]}

${UNTRUSTED_DATA_RULE}`;

/** Stable prompt identity for recording/routing (the template itself is a factory). */
export function matchRequirementsSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/** Recursive object-key sort (arrays keep their order — it is meaningful). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * LLM requirement classification (spec 003 §FR-7 step 2, T3.3): verdicts for
 * the requirements the deterministic pre-pass could not resolve. Strong model
 * tier — accuracy where it matters. Cache identity = hash of (profile
 * projection + requirement set), stable across requirement reordering (spec
 * §FR-10: profile version + req-set hash).
 *
 * validate() goes beyond zod: exactly one verdict per input requirement id,
 * candidate_evidence paths must resolve in the full Candidate Profile,
 * "unknown" cites nothing and "missing" must cite. Returning null triggers
 * the gateway's repair retry; still-invalid output fails the call.
 */
export function createMatchRequirementsTemplate(
  context: MatchRequirementsContext,
): PromptTemplate<MatchRequirementsInput, MatchRequirementsOutput> {
  return {
    templateVersion: MATCH_REQUIREMENTS_TEMPLATE_VERSION,
    buildSystemPrompt: () => SYSTEM_PROMPT,
    buildUserMessage: (input) =>
      `Classify each requirement against the candidate profile projection.\n\n${dataBlock(
        "candidate_profile",
        JSON.stringify(input.profile, null, 2),
      )}\n\n${dataBlock("requirements", JSON.stringify(input.requirements, null, 2))}`,
    schema: matchRequirementsOutputSchema,
    validate: (raw) => {
      const parsed = matchRequirementsOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      const { verdicts } = parsed.data;

      // One verdict per input requirement id — no missing, extras, or dupes.
      if (verdicts.length !== context.requirementIds.length) return null;
      const expected = new Set(context.requirementIds);
      const seen = new Set<string>();
      for (const verdict of verdicts) {
        if (!expected.has(verdict.requirement_id) || seen.has(verdict.requirement_id)) {
          return null;
        }
        seen.add(verdict.requirement_id);
      }

      for (const verdict of verdicts) {
        // UNKNOWN is silence — there is nothing to cite; MISSING is a
        // negative claim and needs the positively covering evidence (§FR-7).
        if (verdict.verdict === "unknown" && verdict.candidate_evidence.length > 0) return null;
        if (verdict.verdict === "missing" && verdict.candidate_evidence.length === 0) return null;
        for (const ref of verdict.candidate_evidence) {
          if (getEvidencedAtPath(context.profile, ref) === null) return null;
        }
      }
      return parsed.data;
    },
    cacheInput: (input) =>
      sha256Hex(
        JSON.stringify(
          canonicalize({
            profile: input.profile,
            requirements: [...input.requirements].sort((a, b) => a.id.localeCompare(b.id)),
          }),
        ),
      ),
    maxTokens: 2048,
    modelTier: "strong",
  };
}
