import { z } from "zod";
import { evidencedSchema } from "./evidenced.schema.js";

/** JobProfile / JobRequirement mirror (spec 003 §FR-5). */

export const remotePolicySchema = z.enum(["onsite", "hybrid", "remote", "unknown"]);

export const requirementImportanceSchema = z.enum(["must_have", "nice_to_have"]);

export const requirementCategorySchema = z.enum([
  "skill",
  "experience",
  "industry",
  "location",
  "language",
  "education",
  "other",
]);

export const jobRequirementSchema = z.object({
  id: z.string().min(1),
  text: evidencedSchema(z.string()),
  category: requirementCategorySchema,
  importance: requirementImportanceSchema,
});

export const jobProfileSchema = z.object({
  required_skills: z.array(evidencedSchema(z.string())),
  preferred_skills: z.array(evidencedSchema(z.string())),
  min_years_experience: evidencedSchema(z.number()),
  industry: evidencedSchema(z.string()),
  location: evidencedSchema(z.string()),
  remote_policy: evidencedSchema(remotePolicySchema),
  languages: z.array(evidencedSchema(z.string())),
  education_requirements: z.array(evidencedSchema(z.string())),
  requirements: z.array(jobRequirementSchema),
});
