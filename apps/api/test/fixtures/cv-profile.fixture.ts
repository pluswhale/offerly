import type { CandidateProfile } from "@offerly/types";
import { candidateProfileSchema } from "../../src/modules/ai/schemas/candidate-profile.schema.js";

/**
 * Recorded extraction fixture (spec 003 §10 testing strategy): one anonymized
 * CV that never mentions databases + the recorded cv-extract.v1 response whose
 * evidence quotes are verbatim spans of that CV. Used by evidence.spec.ts
 * (S2 verifier) and cv-extract.spec.ts (S1 template) so the golden verbatim
 * rate (spec AC-1/AC-2) is asserted against the same artifact.
 */

export const CV_TEXT = `Jane Doe
Senior Backend Engineer
Berlin, Germany

EXPERIENCE
Senior Backend Engineer, Acme GmbH (Mar 2019 - present)
- Led a team of 4 engineers building payment APIs
- Built services in TypeScript and NestJS

Backend Developer, WebShop AG (Jun 2015 - Feb 2019)
- Developed e-commerce features in JavaScript

EDUCATION
BSc Computer Science, TU Berlin, 2014

LANGUAGES
English (fluent), German (native)
`;

export const CV_CONTENT_HASH = "fixture-cv-hash-0001";

const stated = (value: unknown, evidence: string, confidence = 0.9) => ({
  value,
  status: "stated",
  confidence,
  evidence,
});

const unknown = { value: null, status: "unknown", confidence: 0, evidence: null };

/** Recorded cv-extract.v1 output for CV_TEXT (no database mention → databases: []). */
export const CV_EXTRACT_RESPONSE = {
  headline: {
    title: stated("Senior Backend Engineer", "Senior Backend Engineer"),
    seniority: stated("senior", "Senior Backend Engineer"),
    // Derived from dated roles only; the dates are the evidence (spec §FR-2).
    total_years_experience: stated(9, "Jun 2015 - Feb 2019"),
  },
  roles: [
    {
      title: stated("Senior Backend Engineer", "Senior Backend Engineer, Acme GmbH"),
      company: stated("Acme GmbH", "Acme GmbH (Mar 2019 - present)"),
      start: stated("Mar 2019", "Mar 2019 - present"),
      end: stated("present", "Mar 2019 - present"),
      industry: unknown,
      scope: stated("team of 4 engineers", "Led a team of 4 engineers building payment APIs"),
      is_current: true,
    },
    {
      title: stated("Backend Developer", "Backend Developer, WebShop AG"),
      company: stated("WebShop AG", "WebShop AG (Jun 2015 - Feb 2019)"),
      start: stated("Jun 2015", "Jun 2015 - Feb 2019"),
      end: stated("Feb 2019", "Jun 2015 - Feb 2019"),
      industry: unknown,
      scope: unknown,
      is_current: false,
    },
  ],
  skills: {
    programming_languages: [
      { ...stated("TypeScript", "Built services in TypeScript and NestJS"), years: null, recency: "Acme GmbH" },
      { ...stated("JavaScript", "Developed e-commerce features in JavaScript") },
    ],
    frameworks: [{ ...stated("NestJS", "Built services in TypeScript and NestJS") }],
    cloud_platforms: [],
    databases: [], // CV never mentions databases → empty array, never invented (AC-2)
    devops_tools: [],
    other_technologies: [],
    soft_skills: [],
  },
  experience: {
    industries: [],
    domains: [],
    team_sizes_managed: stated(4, "Led a team of 4 engineers building payment APIs"),
    leadership: stated(true, "Led a team of 4 engineers building payment APIs"),
    leadership_scope: stated(
      "team of 4 engineers",
      "Led a team of 4 engineers building payment APIs",
    ),
    management: unknown,
    management_scope: unknown,
  },
  education: [
    {
      degree: stated("BSc Computer Science", "BSc Computer Science, TU Berlin, 2014"),
      institution: stated("TU Berlin", "BSc Computer Science, TU Berlin, 2014"),
      year: stated(2014, "BSc Computer Science, TU Berlin, 2014"),
    },
  ],
  certifications: [],
  languages: [
    { language: stated("English", "English (fluent)"), level: stated("fluent", "English (fluent)") },
    { language: stated("German", "German (native)"), level: stated("native", "German (native)") },
  ],
  location: {
    current: stated("Berlin, Germany", "Berlin, Germany"),
    work_authorization: [],
    remote_preference: unknown,
  },
};

/** The fixture response parsed through the zod boundary into a typed profile. */
export function fixtureProfile(): CandidateProfile {
  const parsed = candidateProfileSchema.safeParse(structuredClone(CV_EXTRACT_RESPONSE));
  if (!parsed.success) {
    throw new Error(`fixture response does not satisfy candidateProfileSchema: ${parsed.error}`);
  }
  return parsed.data;
}
