import type { JobProfile } from "@offerly/types";
import { jobProfileSchema } from "../../src/modules/ai/schemas/job-profile.schema.js";

/**
 * Recorded jd-extract.v1 responses (spec 003 §10 testing strategy) for the
 * ai-benchmark JD fixtures (test/fixtures/ai-benchmark/jds/*). Every evidence
 * quote is a verbatim span of the corresponding .jd.txt, so the S2 verbatim
 * check passes on replay and a fabricated quote is detectable by the tests.
 */

const stated = (value: unknown, evidence: string, confidence = 0.9) => ({
  value,
  status: "stated",
  confidence,
  evidence,
});

const unknown = { value: null, status: "unknown", confidence: 0, evidence: null };

/** Recorded jd-extract.v1 output for senior-backend-fintech.jd.txt. */
export const FINTECH_EXTRACT_RESPONSE = {
  required_skills: [
    stated("TypeScript", "Strong TypeScript and Node.js skills"),
    stated("Node.js", "Strong TypeScript and Node.js skills"),
    stated("PostgreSQL", "Production experience with PostgreSQL and Redis"),
    stated("Redis", "Production experience with PostgreSQL and Redis"),
    stated("AWS", "Hands-on AWS experience (ECS, RDS)"),
    stated("Docker", "Docker-based deployments and CI/CD pipelines"),
    stated("CI/CD", "Docker-based deployments and CI/CD pipelines"),
  ],
  preferred_skills: [stated("Kubernetes", "Kubernetes")],
  min_years_experience: stated(5, "5+ years of backend development experience"),
  industry: stated("fintech", "Experience in fintech or payments"),
  location: stated("Berlin, Germany", "FinLane GmbH — Berlin, Germany"),
  remote_policy: stated("hybrid", "hybrid, 3 days per week in the office"),
  languages: [stated("English", "Fluent English (C1)")],
  education_requirements: [],
  requirements: [
    {
      id: "req-1",
      text: stated(
        "5+ years of backend development experience",
        "5+ years of backend development experience",
      ),
      category: "experience",
      importance: "must_have",
    },
    {
      id: "req-2",
      text: stated("Strong TypeScript and Node.js skills", "Strong TypeScript and Node.js skills"),
      category: "skill",
      importance: "must_have",
    },
    {
      id: "req-3",
      text: stated(
        "Production experience with PostgreSQL and Redis",
        "Production experience with PostgreSQL and Redis",
      ),
      category: "skill",
      importance: "must_have",
    },
    {
      id: "req-4",
      text: stated("Hands-on AWS experience (ECS, RDS)", "Hands-on AWS experience (ECS, RDS)"),
      category: "skill",
      importance: "must_have",
    },
    {
      id: "req-5",
      text: stated(
        "Docker-based deployments and CI/CD pipelines",
        "Docker-based deployments and CI/CD pipelines",
      ),
      category: "skill",
      importance: "must_have",
    },
    {
      id: "req-6",
      text: stated("Fluent English (C1)", "Fluent English (C1)"),
      category: "language",
      importance: "must_have",
    },
    {
      id: "req-7",
      text: stated("Experience in fintech or payments", "Experience in fintech or payments"),
      category: "industry",
      importance: "nice_to_have",
    },
    {
      id: "req-8",
      text: stated("Kubernetes", "Kubernetes"),
      category: "skill",
      importance: "nice_to_have",
    },
    {
      id: "req-9",
      text: stated("German language skills", "German language skills"),
      category: "language",
      importance: "nice_to_have",
    },
  ],
};

/**
 * Recorded jd-extract.v1 output for vague-rockstar.jd.txt: the JD states zero
 * concrete requirements, so everything structured stays empty/UNKNOWN rather
 * than inferred from buzzwords (spec §FR-5 honesty rule).
 */
export const VAGUE_EXTRACT_RESPONSE = {
  required_skills: [],
  preferred_skills: [],
  min_years_experience: unknown,
  industry: unknown,
  location: unknown,
  remote_policy: unknown,
  languages: [],
  education_requirements: [],
  requirements: [],
};

/** A fixture response parsed through the zod boundary into a typed profile. */
export function fixtureJobProfile(response: unknown = FINTECH_EXTRACT_RESPONSE): JobProfile {
  const parsed = jobProfileSchema.safeParse(structuredClone(response));
  if (!parsed.success) {
    throw new Error(`fixture response does not satisfy jobProfileSchema: ${parsed.error}`);
  }
  return parsed.data;
}
