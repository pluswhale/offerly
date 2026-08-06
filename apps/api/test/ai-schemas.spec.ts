import { describe, expect, it } from "vitest";
import {
  candidateProfileSchema,
  evidencedSchema,
  jobProfileSchema,
  matchReportV2Schema,
} from "../src/modules/ai/schemas/index.js";
import { z } from "zod";

const stated = (value: unknown, evidence = "verbatim quote from the document") => ({
  value,
  status: "stated",
  confidence: 0.9,
  evidence,
});

const unknown = { value: null, status: "unknown", confidence: 0, evidence: null };

/** Minimal but complete valid CandidateProfile (spec §FR-2). */
const VALID_PROFILE = {
  headline: {
    title: stated("Senior Backend Engineer"),
    seniority: stated("senior"),
    total_years_experience: stated(7, "2017 - present"),
  },
  roles: [
    {
      title: stated("Backend Engineer"),
      company: stated("Acme Corp"),
      start: stated("2017"),
      end: stated("present"),
      industry: stated("fintech"),
      scope: stated("team of 5"),
      is_current: true,
    },
  ],
  skills: {
    programming_languages: [{ ...stated("TypeScript"), years: 5, recency: "Acme Corp" }],
    frameworks: [stated("NestJS")],
    cloud_platforms: [],
    databases: [], // CV never mentions databases → empty array, never invented (AC-2)
    devops_tools: [],
    other_technologies: [],
    soft_skills: [],
  },
  experience: {
    industries: [stated("fintech")],
    domains: [stated("B2B SaaS")],
    team_sizes_managed: unknown,
    leadership: { ...stated(true), },
    leadership_scope: stated("tech lead for 3 engineers"),
    management: unknown,
    management_scope: unknown,
  },
  education: [
    {
      degree: stated("BSc Computer Science"),
      institution: stated("TU Berlin"),
      year: stated(2015, "graduated 2015"),
    },
  ],
  certifications: [],
  languages: [
    { language: stated("English"), level: stated("fluent") },
    { language: unknown, level: unknown },
  ],
  location: {
    current: stated("Berlin"),
    work_authorization: [stated("EU citizen")],
    remote_preference: stated("hybrid"),
  },
};

describe("candidateProfileSchema (T1.1)", () => {
  it("parses a hand-written valid profile", () => {
    const result = candidateProfileSchema.safeParse(VALID_PROFILE);
    expect(result.success).toBe(true);
  });

  it("parses a profile with summary_quality set (derived in S4)", () => {
    const result = candidateProfileSchema.safeParse({ ...VALID_PROFILE, summary_quality: 80 });
    expect(result.success).toBe(true);
  });

  it("rejects a missing field — omission is a schema error, not an implicit unknown", () => {
    const { skills: _omitted, ...noSkills } = VALID_PROFILE;
    expect(candidateProfileSchema.safeParse(noSkills).success).toBe(false);

    const noNested = {
      ...VALID_PROFILE,
      headline: { title: stated("x"), seniority: stated("senior") }, // missing total_years_experience
    };
    expect(candidateProfileSchema.safeParse(noNested).success).toBe(false);
  });

  it("rejects status 'stated' with null evidence", () => {
    const bad = {
      ...VALID_PROFILE,
      headline: {
        ...VALID_PROFILE.headline,
        title: { value: "Engineer", status: "stated", confidence: 0.9, evidence: null },
      },
    };
    expect(candidateProfileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects status 'unknown' with a non-null value (or non-null evidence)", () => {
    const badValue = {
      ...VALID_PROFILE,
      experience: {
        ...VALID_PROFILE.experience,
        management: { value: true, status: "unknown", confidence: 0.5, evidence: null },
      },
    };
    expect(candidateProfileSchema.safeParse(badValue).success).toBe(false);

    const badEvidence = {
      ...VALID_PROFILE,
      experience: {
        ...VALID_PROFILE.experience,
        management: { value: null, status: "unknown", confidence: 0.5, evidence: "some quote" },
      },
    };
    expect(candidateProfileSchema.safeParse(badEvidence).success).toBe(false);
  });

  it("allows stated + null evidence for user corrections (spec §FR-4)", () => {
    const corrected = {
      ...VALID_PROFILE,
      headline: {
        ...VALID_PROFILE.headline,
        title: {
          value: "Staff Engineer",
          status: "stated",
          confidence: 1,
          evidence: null,
          source: "user",
        },
      },
    };
    expect(candidateProfileSchema.safeParse(corrected).success).toBe(true);
  });

  it("rejects confidence outside 0–1", () => {
    const bad = {
      ...VALID_PROFILE,
      headline: {
        ...VALID_PROFILE.headline,
        title: { value: "x", status: "stated", confidence: 1.5, evidence: "q" },
      },
    };
    expect(candidateProfileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("evidencedSchema invariants (T1.1)", () => {
  const schema = evidencedSchema(z.string());
  it("enforces stated/unknown cross-field rules standalone", () => {
    expect(schema.safeParse({ value: "a", status: "stated", confidence: 1, evidence: "q" }).success).toBe(true);
    expect(schema.safeParse({ value: null, status: "stated", confidence: 1, evidence: "q" }).success).toBe(false);
    expect(schema.safeParse({ value: "a", status: "unknown", confidence: 0, evidence: null }).success).toBe(false);
    expect(schema.safeParse({ value: null, status: "unknown", confidence: 0, evidence: null }).success).toBe(true);
  });
});

const VALID_JOB_PROFILE = {
  required_skills: [stated("Kubernetes")],
  preferred_skills: [stated("Terraform")],
  min_years_experience: stated(5, "5+ years of experience"),
  industry: stated("fintech"),
  location: stated("Berlin"),
  remote_policy: stated("hybrid", "hybrid work model"),
  languages: [stated("English")],
  education_requirements: [],
  requirements: [
    {
      id: "req-1",
      text: stated("5+ years of backend experience"),
      category: "experience",
      importance: "must_have",
    },
    {
      id: "req-2",
      text: stated("German is a plus"),
      category: "language",
      importance: "nice_to_have",
    },
  ],
};

describe("jobProfileSchema (T1.1)", () => {
  it("parses a valid job profile and rejects malformed ones", () => {
    expect(jobProfileSchema.safeParse(VALID_JOB_PROFILE).success).toBe(true);
    expect(jobProfileSchema.safeParse({ ...VALID_JOB_PROFILE, requirements: [{}] }).success).toBe(false);
    expect(
      jobProfileSchema.safeParse({
        ...VALID_JOB_PROFILE,
        remote_policy: { value: "anywhere", status: "stated", confidence: 1, evidence: "q" },
      }).success,
    ).toBe(false);
  });
});

describe("matchReportV2Schema (T1.1)", () => {
  it("parses a valid v2 report", () => {
    const component = { weight: 0.45, component_score: 1, contribution: 0.45 };
    const report = {
      version: 2,
      score: 100,
      weights_version: "weights.v1",
      breakdown: {
        must_have: component,
        nice_to_have: { weight: 0.2, component_score: 1, contribution: 0.2 },
        experience: { weight: 0.15, component_score: 1, contribution: 0.15 },
        industry: { weight: 0.08, component_score: 1, contribution: 0.08 },
        location_remote: { weight: 0.05, component_score: 1, contribution: 0.05 },
        languages: { weight: 0.04, component_score: 1, contribution: 0.04 },
        education: { weight: 0.03, component_score: 1, contribution: 0.03 },
      },
      verdicts: [
        {
          requirement_id: "req-1",
          verdict: "match",
          confidence: 0.95,
          candidate_evidence: ["skills.programming_languages[0]"],
          reasoning: "Profile lists Kubernetes with 5 years.",
        },
      ],
      low_confidence: false,
      unknown_must_have_share: 0,
      template_versions: { "jd-extract": "jd-extract.v1", "match-requirements": "match-requirements.v1" },
    };
    expect(matchReportV2Schema.safeParse(report).success).toBe(true);
    expect(matchReportV2Schema.safeParse({ ...report, version: 1 }).success).toBe(false);
    expect(matchReportV2Schema.safeParse({ ...report, score: 101 }).success).toBe(false);
  });
});
