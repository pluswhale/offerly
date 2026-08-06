import type {
  CandidateProfile,
  Evidenced,
  JobRequirement,
  ProfileSkills,
  RequirementVerdict,
} from "@offerly/types";
import type { AiService } from "../ai.service.js";
import {
  createMatchRequirementsTemplate,
  MATCH_REQUIREMENTS_TEMPLATE_VERSION,
  type MatchRequirementItem,
  type ProfileProjection,
  type ProjectedFact,
  type ProjectedSkill,
} from "../prompts/match-requirements.v1.js";

/**
 * LLM requirement classification caller (spec 003 §FR-7 step 2, T3.3): builds
 * the compact profile projection, sends only the pre-pass-unresolved
 * requirements through match-requirements.v1 (usage op `match_requirements`),
 * and returns validated verdicts. The template's validate() rejects verdicts
 * citing non-existent profile paths and any output that does not cover every
 * requirement id exactly once — the gateway retries once, then the call fails.
 */

const SKILL_GROUPS = [
  "programming_languages",
  "frameworks",
  "cloud_platforms",
  "databases",
  "devops_tools",
  "other_technologies",
  "soft_skills",
] as const satisfies readonly (keyof ProfileSkills)[];

function fact<T>(path: string, leaf: Evidenced<T>): ProjectedFact {
  return { path, value: leaf.value, status: leaf.status, evidence: leaf.evidence };
}

/** Stated array members only — absence from the projection reads as silence. */
function statedFacts<T>(prefix: string, items: readonly Evidenced<T>[]): ProjectedFact[] {
  const facts: ProjectedFact[] = [];
  items.forEach((item, index) => {
    if (item.status === "stated" && item.value !== null) {
      facts.push(fact(`${prefix}[${index}]`, item));
    }
  });
  return facts;
}

/**
 * The compact, evidence-bearing profile subset match-requirements.v1 sees
 * (spec §FR-10): relevant fields only, each tagged with its full-profile
 * field path so verdict citations validate against the CandidateProfile.
 * Scalars are always present (status reveals silence); arrays carry stated
 * members only. Roles and raw CV text are intentionally excluded.
 */
export function buildProfileProjection(profile: CandidateProfile): ProfileProjection {
  const skills: ProjectedSkill[] = [];
  for (const group of SKILL_GROUPS) {
    profile.skills[group].forEach((skill, index) => {
      if (skill.status !== "stated" || skill.value === null) return;
      skills.push({
        path: `skills.${group}[${index}]`,
        value: skill.value,
        status: skill.status,
        evidence: skill.evidence,
        years: skill.years ?? null,
        recency: skill.recency ?? null,
      });
    });
  }

  const education: ProjectedFact[] = [];
  profile.education.forEach((entry, index) => {
    if (entry.degree.status !== "stated" || entry.degree.value === null) return;
    education.push(
      fact(`education[${index}].degree`, entry.degree),
      fact(`education[${index}].institution`, entry.institution),
      fact(`education[${index}].year`, entry.year),
    );
  });

  const certifications: ProjectedFact[] = [];
  profile.certifications.forEach((entry, index) => {
    if (entry.name.status !== "stated" || entry.name.value === null) return;
    certifications.push(
      fact(`certifications[${index}].name`, entry.name),
      fact(`certifications[${index}].issuer`, entry.issuer),
      fact(`certifications[${index}].year`, entry.year),
    );
  });

  const languages: ProjectedFact[] = [];
  profile.languages.forEach((entry, index) => {
    if (entry.language.status !== "stated" || entry.language.value === null) return;
    // The level is included even when unknown: silence on level is exactly
    // what a level-demanding requirement must see to stay 'unknown'.
    languages.push(
      fact(`languages[${index}].language`, entry.language),
      fact(`languages[${index}].level`, entry.level),
    );
  });

  return {
    headline: [
      fact("headline.title", profile.headline.title),
      fact("headline.seniority", profile.headline.seniority),
      fact("headline.total_years_experience", profile.headline.total_years_experience),
    ],
    skills,
    industries: statedFacts("experience.industries", profile.experience.industries),
    domains: statedFacts("experience.domains", profile.experience.domains),
    experience: [
      fact("experience.team_sizes_managed", profile.experience.team_sizes_managed),
      fact("experience.leadership", profile.experience.leadership),
      fact("experience.leadership_scope", profile.experience.leadership_scope),
      fact("experience.management", profile.experience.management),
      fact("experience.management_scope", profile.experience.management_scope),
    ],
    education,
    certifications,
    languages,
    location: [
      fact("location.current", profile.location.current),
      ...statedFacts("location.work_authorization", profile.location.work_authorization),
      fact("location.remote_preference", profile.location.remote_preference),
    ],
  };
}

export interface MatchRequirementsMeta {
  templateVersion: string;
  /** True when no requirement reached the LLM — zero usage. */
  skipped: boolean;
  cacheHit: boolean;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface MatchRequirementsResult {
  /** Verdicts for the unresolved requirements, in input order. */
  verdicts: RequirementVerdict[];
  meta: MatchRequirementsMeta;
}

/**
 * Classify the pre-pass-unresolved requirements via match-requirements.v1.
 * Requirements whose own text is not stated cannot be classified and get a
 * deterministic 'unknown' verdict without an LLM call; when nothing remains
 * for the LLM the call is skipped entirely (zero usage), like S3.
 */
export async function matchRequirements(
  ai: AiService,
  opts: {
    userId: string;
    profile: CandidateProfile;
    unresolved: readonly JobRequirement[];
    skipCache?: boolean;
  },
): Promise<MatchRequirementsResult> {
  const started = Date.now();
  const verdicts: RequirementVerdict[] = [];
  const items: MatchRequirementItem[] = [];

  for (const req of opts.unresolved) {
    const text = req.text.value;
    if (req.text.status !== "stated" || text === null) {
      verdicts.push({
        requirement_id: req.id,
        verdict: "unknown",
        confidence: 1,
        candidate_evidence: [],
        reasoning: "The requirement text itself is not stated in the job profile.",
      });
      continue;
    }
    items.push({ id: req.id, text, category: req.category, importance: req.importance });
  }

  if (items.length === 0) {
    return {
      verdicts,
      meta: {
        templateVersion: MATCH_REQUIREMENTS_TEMPLATE_VERSION,
        skipped: true,
        cacheHit: false,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: Date.now() - started,
      },
    };
  }

  const template = createMatchRequirementsTemplate({
    profile: opts.profile,
    requirementIds: items.map((item) => item.id),
  });
  const result = await ai.generateFromTemplate({
    userId: opts.userId,
    operation: "match_requirements",
    template,
    input: { profile: buildProfileProjection(opts.profile), requirements: items },
    skipCache: opts.skipCache,
  });
  verdicts.push(...result.data.verdicts);

  return {
    verdicts,
    meta: {
      templateVersion: MATCH_REQUIREMENTS_TEMPLATE_VERSION,
      skipped: false,
      cacheHit: result.cacheHit,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: Date.now() - started,
    },
  };
}
