import { z } from "zod";
import { evidencedSchema } from "./evidenced.schema.js";

/** CandidateProfile mirror (spec 003 §FR-2). Validated server-side at the API boundary. */

export const senioritySchema = z.enum([
  "junior",
  "mid",
  "senior",
  "staff",
  "lead",
  "manager",
  "executive",
]);

export const languageLevelSchema = z.enum(["native", "fluent", "professional", "basic"]);

export const remotePreferenceSchema = z.enum(["onsite", "hybrid", "remote", "any"]);

const evidencedString = evidencedSchema(z.string());
const evidencedNumber = evidencedSchema(z.number());

export const evidencedSkillSchema = evidencedSchema(z.string()).extend({
  years: z.number().nullable().optional(),
  recency: z.string().nullable().optional(),
});

export const profileHeadlineSchema = z.object({
  title: evidencedString,
  seniority: evidencedSchema(senioritySchema),
  total_years_experience: evidencedNumber,
});

export const profileRoleSchema = z.object({
  title: evidencedString,
  company: evidencedString,
  start: evidencedString,
  end: evidencedString,
  industry: evidencedString,
  scope: evidencedString,
  is_current: z.boolean(),
});

export const profileSkillsSchema = z.object({
  programming_languages: z.array(evidencedSkillSchema),
  frameworks: z.array(evidencedSkillSchema),
  cloud_platforms: z.array(evidencedSkillSchema),
  databases: z.array(evidencedSkillSchema),
  devops_tools: z.array(evidencedSkillSchema),
  other_technologies: z.array(evidencedSkillSchema),
  soft_skills: z.array(evidencedSkillSchema),
});

export const profileExperienceSchema = z.object({
  industries: z.array(evidencedString),
  domains: z.array(evidencedString),
  team_sizes_managed: evidencedNumber,
  leadership: evidencedSchema(z.boolean()),
  leadership_scope: evidencedString,
  management: evidencedSchema(z.boolean()),
  management_scope: evidencedString,
});

export const profileEducationSchema = z.object({
  degree: evidencedString,
  institution: evidencedString,
  year: evidencedNumber,
});

export const profileCertificationSchema = z.object({
  name: evidencedString,
  issuer: evidencedString,
  year: evidencedNumber,
});

export const profileLanguageSchema = z.object({
  language: evidencedString,
  level: evidencedSchema(languageLevelSchema),
});

export const profileLocationSchema = z.object({
  current: evidencedString,
  work_authorization: z.array(evidencedString),
  remote_preference: evidencedSchema(remotePreferenceSchema),
});

/**
 * summary_quality is derived at persist time (S4), not extracted — optional so
 * the extraction output and the stored profile share one schema.
 */
export const candidateProfileSchema = z.object({
  headline: profileHeadlineSchema,
  roles: z.array(profileRoleSchema),
  skills: profileSkillsSchema,
  experience: profileExperienceSchema,
  education: z.array(profileEducationSchema),
  certifications: z.array(profileCertificationSchema),
  languages: z.array(profileLanguageSchema),
  location: profileLocationSchema,
  summary_quality: z.number().min(0).max(100).optional(),
});
