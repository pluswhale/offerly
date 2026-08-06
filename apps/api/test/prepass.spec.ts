import type {
  CandidateProfile,
  Evidenced,
  JobRequirement,
  RemotePreference,
  RequirementCategory,
  RequirementImportance,
} from "@offerly/types";
import { describe, expect, it } from "vitest";
import {
  parseMinYears,
  resolveBatch,
  resolveRequirement,
} from "../src/modules/ai/matching/prepass.js";
import { fixtureProfile } from "./fixtures/cv-profile.fixture.js";

/* ---------- helpers ---------- */

const statedLeaf = <T>(value: T, evidence: string): Evidenced<T> => ({
  value,
  status: "stated",
  confidence: 0.9,
  evidence,
});

const unknownLeaf = <T>(): Evidenced<T> => ({
  value: null,
  status: "unknown",
  confidence: 0,
  evidence: null,
});

const req = (
  id: string,
  text: string,
  category: RequirementCategory,
  importance: RequirementImportance = "must_have",
): JobRequirement => ({
  id,
  text: statedLeaf(text, text),
  category,
  importance,
});

/** Jane Doe fixture: TS/JS/NestJS, 9y, Berlin, EN fluent + DE native, BSc, remote unknown. */
const profile = (): CandidateProfile => fixtureProfile();

/** A profile silent on everything the pre-pass looks at. */
const silentProfile = (): CandidateProfile => {
  const p = fixtureProfile();
  p.skills = {
    programming_languages: [],
    frameworks: [],
    cloud_platforms: [],
    databases: [],
    devops_tools: [],
    other_technologies: [],
    soft_skills: [],
  };
  p.headline.total_years_experience = unknownLeaf<number>();
  p.location.current = unknownLeaf<string>();
  p.location.remote_preference = unknownLeaf<RemotePreference>();
  p.languages = [];
  p.education = [];
  return p;
};

/* ---------- skill rules ---------- */

describe("resolveRequirement — skill", () => {
  it("canonical case: k8s requirement + kubernetes skill → match via alias", () => {
    const p = profile();
    p.skills.devops_tools.push(statedLeaf("Kubernetes", "Deployed services on Kubernetes"));
    const v = resolveRequirement(req("r1", "k8s", "skill"), p);
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^skills\.devops_tools\[0\]: "Deployed services/);
    expect(v?.confidence).toBe(1);
  });

  it("exact match against a stated skill cites the profile field path", () => {
    const v = resolveRequirement(req("r1", "TypeScript", "skill"), profile());
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^skills\.programming_languages\[0\]/);
  });

  it("alias folds inside longer requirement text", () => {
    const p = profile();
    p.skills.databases.push(statedLeaf("postgres", "Migrated the postgres cluster"));
    const v = resolveRequirement(
      req("r1", "Experience with PostgreSQL in production", "skill"),
      p,
    );
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^skills\.databases\[0\]/);
  });

  it("fuzzy adjacency is NOT resolved: react requirement vs react native skill → null", () => {
    const p = silentProfile();
    p.skills.frameworks.push(statedLeaf("React Native", "Built mobile apps in React Native"));
    expect(resolveRequirement(req("r1", "React", "skill"), p)).toBeNull();
  });

  it("absent skill → null (never 'missing' from a skill list)", () => {
    expect(resolveRequirement(req("r1", "Docker", "skill"), profile())).toBeNull();
  });
});

/* ---------- experience rules ---------- */

describe("parseMinYears", () => {
  it("parses the common phrasings to their minimum", () => {
    expect(parseMinYears("5+ years of experience")).toBe(5);
    expect(parseMinYears("3-5 years")).toBe(3);
    expect(parseMinYears("at least 7 years")).toBe(7);
    expect(parseMinYears("2 – 4 Years")).toBe(2);
    expect(parseMinYears("senior mindset")).toBeNull();
  });
});

describe("resolveRequirement — experience", () => {
  it("meets the minimum → match", () => {
    const v = resolveRequirement(req("r1", "5+ years of professional experience", "experience"), profile());
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^headline\.total_years_experience/);
  });

  it("canonical case: 5-years requirement + 2 stated years → missing", () => {
    const p = profile();
    p.headline.total_years_experience = statedLeaf(2, "Jun 2022 - present");
    const v = resolveRequirement(req("r1", "5+ years", "experience"), p);
    expect(v?.verdict).toBe("missing");
    expect(v?.candidate_evidence[0]).toMatch(/^headline\.total_years_experience/);
  });

  it("canonical case: 5-years requirement + unknown years → unknown", () => {
    const p = profile();
    p.headline.total_years_experience = unknownLeaf<number>();
    const v = resolveRequirement(req("r1", "5+ years", "experience"), p);
    expect(v?.verdict).toBe("unknown");
    expect(v?.candidate_evidence).toEqual([]);
  });

  it("range minimum is used (3-5 years, 9 stated → match)", () => {
    const v = resolveRequirement(req("r1", "3-5 years in backend", "experience"), profile());
    expect(v?.verdict).toBe("match");
  });

  it("no years in the requirement text → null", () => {
    expect(resolveRequirement(req("r1", "Senior mindset", "experience"), profile())).toBeNull();
  });
});

/* ---------- location / remote rules ---------- */

describe("resolveRequirement — location", () => {
  it("remote requirement + stated remote preference → match", () => {
    const p = profile();
    p.location.remote_preference = statedLeaf<RemotePreference>("remote", "Looking for remote work");
    const v = resolveRequirement(req("r1", "Fully remote position", "location"), p);
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^location\.remote_preference/);
  });

  it("remote requirement + stated onsite preference → missing", () => {
    const p = profile();
    p.location.remote_preference = statedLeaf<RemotePreference>("onsite", "Prefers working onsite");
    const v = resolveRequirement(req("r1", "Remote-first company", "location"), p);
    expect(v?.verdict).toBe("missing");
  });

  it("remote requirement + unstated preference → unknown", () => {
    const v = resolveRequirement(req("r1", "Fully remote position", "location"), profile());
    expect(v?.verdict).toBe("unknown");
    expect(v?.candidate_evidence).toEqual([]);
  });

  it("hybrid requirement + stated hybrid preference → match", () => {
    const p = profile();
    p.location.remote_preference = statedLeaf<RemotePreference>("hybrid", "Open to hybrid");
    expect(resolveRequirement(req("r1", "Hybrid, 2 days onsite", "location"), p)?.verdict).toBe(
      "match",
    );
  });

  it("named place matching the stated current location → match", () => {
    const v = resolveRequirement(req("r1", "Based in our Berlin office", "location"), profile());
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^location\.current/);
  });

  it("named place + unstated current location → unknown", () => {
    const p = profile();
    p.location.current = unknownLeaf<string>();
    expect(resolveRequirement(req("r1", "Berlin office", "location"), p)?.verdict).toBe(
      "unknown",
    );
  });

  it("different named place → null (relocation is a judgment call)", () => {
    expect(resolveRequirement(req("r1", "Munich office", "location"), profile())).toBeNull();
  });
});

/* ---------- language rules ---------- */

describe("resolveRequirement — language", () => {
  it("canonical case: German required + languages [EN, RU] stated → missing", () => {
    const p = profile();
    p.languages = [
      { language: statedLeaf("English", "English (fluent)"), level: statedLeaf("fluent" as const, "English (fluent)") },
      { language: statedLeaf("Russian", "Russian (native)"), level: statedLeaf("native" as const, "Russian (native)") },
    ];
    const v = resolveRequirement(req("r1", "German required", "language"), p);
    expect(v?.verdict).toBe("missing");
    expect(v?.candidate_evidence).toHaveLength(2);
    expect(v?.candidate_evidence[0]).toMatch(/^languages\[0\]\.language/);
  });

  it("canonical case: languages unstated → unknown", () => {
    const p = profile();
    p.languages = [];
    const v = resolveRequirement(req("r1", "German required", "language"), p);
    expect(v?.verdict).toBe("unknown");
    expect(v?.candidate_evidence).toEqual([]);
  });

  it("required language stated without a level in the JD → match", () => {
    const v = resolveRequirement(req("r1", "German required", "language"), profile());
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^languages\[1\]\.language/);
  });

  it("required level met → match (C1 vs fluent)", () => {
    const v = resolveRequirement(req("r1", "English (C1)", "language"), profile());
    expect(v?.verdict).toBe("match");
  });

  it("required level clearly not met → missing (fluent vs basic)", () => {
    const p = profile();
    p.languages = [
      { language: statedLeaf("German", "German (basic)"), level: statedLeaf("basic" as const, "German (basic)") },
    ];
    const v = resolveRequirement(req("r1", "Fluent German", "language"), p);
    expect(v?.verdict).toBe("missing");
  });

  it("stated level unknown + JD demands a level → null (adequacy is fuzzy)", () => {
    const p = profile();
    p.languages = [
      { language: statedLeaf("German", "German"), level: unknownLeaf() },
    ];
    expect(resolveRequirement(req("r1", "Fluent German", "language"), p)).toBeNull();
  });

  it("no detectable language in the requirement → null", () => {
    expect(
      resolveRequirement(req("r1", "Strong communication skills", "language"), profile()),
    ).toBeNull();
  });
});

/* ---------- education rules ---------- */

describe("resolveRequirement — education", () => {
  it("bachelor required + stated BSc → match", () => {
    const v = resolveRequirement(
      req("r1", "Bachelor's degree in Computer Science", "education"),
      profile(),
    );
    expect(v?.verdict).toBe("match");
    expect(v?.candidate_evidence[0]).toMatch(/^education\[0\]\.degree/);
  });

  it("master required + only BSc stated → missing", () => {
    const v = resolveRequirement(req("r1", "Master's degree", "education"), profile());
    expect(v?.verdict).toBe("missing");
  });

  it("education array empty (silence) → unknown, never missing", () => {
    const p = profile();
    p.education = [];
    const v = resolveRequirement(req("r1", "Bachelor's degree", "education"), p);
    expect(v?.verdict).toBe("unknown");
    expect(v?.candidate_evidence).toEqual([]);
  });

  it("no degree keyword in the requirement → null", () => {
    expect(
      resolveRequirement(req("r1", "Lifelong learner", "education"), profile()),
    ).toBeNull();
  });
});

/* ---------- non-rule categories & UNKNOWN/MISSING invariant ---------- */

describe("resolveRequirement — invariant (spec §FR-7)", () => {
  it("industry and other categories always go to the LLM", () => {
    expect(resolveRequirement(req("r1", "Fintech experience", "industry"), profile())).toBeNull();
    expect(resolveRequirement(req("r1", "Team player", "other"), profile())).toBeNull();
  });

  it("a fully silent profile never yields 'missing' — only 'unknown' or null", () => {
    const p = silentProfile();
    const verdicts = [
      resolveRequirement(req("r1", "Docker", "skill"), p),
      resolveRequirement(req("r2", "5+ years", "experience"), p),
      resolveRequirement(req("r3", "Remote position", "location"), p),
      resolveRequirement(req("r4", "Berlin office", "location"), p),
      resolveRequirement(req("r5", "German required", "language"), p),
      resolveRequirement(req("r6", "Bachelor's degree", "education"), p),
      resolveRequirement(req("r7", "Team player", "other"), p),
    ];
    for (const v of verdicts) {
      expect(v?.verdict).not.toBe("missing");
    }
    expect(verdicts.filter((v) => v?.verdict === "unknown")).toHaveLength(5);
    expect(verdicts.filter((v) => v === null)).toHaveLength(2);
  });

  it("requirement with unstated text → null", () => {
    const r: JobRequirement = {
      id: "r1",
      text: unknownLeaf<string>(),
      category: "skill",
      importance: "must_have",
    };
    expect(resolveRequirement(r, profile())).toBeNull();
  });
});

/* ---------- batch ---------- */

describe("resolveBatch (T3.2 acceptance: ≥40% deterministic)", () => {
  const requirements: JobRequirement[] = [
    req("r1", "TypeScript", "skill"),
    req("r2", "NestJS", "skill", "nice_to_have"),
    req("r3", "5+ years of professional experience", "experience"),
    req("r4", "12+ years", "experience", "nice_to_have"),
    req("r5", "English (fluent)", "language"),
    req("r6", "French", "language", "nice_to_have"),
    req("r7", "Bachelor's degree in Computer Science or equivalent", "education"),
    req("r8", "Berlin", "location"),
    req("r9", "Fully remote", "location", "nice_to_have"),
    req("r10", "Kubernetes", "skill"), // absent skill → LLM
    req("r11", "Team player", "other"), // no rules → LLM
    req("r12", "Fintech experience", "industry"), // no rules → LLM
  ];

  it("resolves the rule-decidable share and forwards the rest", () => {
    const { resolved, unresolved } = resolveBatch(requirements, profile());
    const ratio = resolved.length / requirements.length;
    expect(ratio).toBeGreaterThanOrEqual(0.4);
    expect(resolved).toHaveLength(9); // 75% of this set
    expect(unresolved.map((r) => r.id)).toEqual(["r10", "r11", "r12"]);
  });

  it("produces the expected verdict mix, including unknown-not-missing", () => {
    const { resolved } = resolveBatch(requirements, profile());
    const byId = new Map(resolved.map((v) => [v.requirement_id, v.verdict]));
    expect(byId.get("r1")).toBe("match");
    expect(byId.get("r2")).toBe("match");
    expect(byId.get("r3")).toBe("match");
    expect(byId.get("r4")).toBe("missing"); // 12+ required, 9 stated
    expect(byId.get("r5")).toBe("match");
    expect(byId.get("r6")).toBe("missing"); // EN/DE stated, French absent
    expect(byId.get("r7")).toBe("match");
    expect(byId.get("r8")).toBe("match");
    expect(byId.get("r9")).toBe("unknown"); // remote preference unstated
  });

  it("every resolved verdict carries the requirement id and grounded reasoning", () => {
    const { resolved } = resolveBatch(requirements, profile());
    for (const v of resolved) {
      expect(v.requirement_id).toMatch(/^r\d+$/);
      expect(v.confidence).toBe(1);
      expect(v.reasoning.length).toBeGreaterThan(0);
      if (v.verdict !== "unknown") {
        expect(v.candidate_evidence.length).toBeGreaterThan(0);
      }
    }
  });
});
