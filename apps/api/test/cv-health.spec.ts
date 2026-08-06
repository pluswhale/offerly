import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type {
  CandidateProfile,
  CvImprovement,
  Evidenced,
  RequirementImportance,
  VerdictValue,
} from "@offerly/types";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import { canonicalizeSkill } from "../src/modules/ai/matching/aliases.js";
import { emptyCandidateProfile } from "../src/modules/candidate-profiles/profile-pipeline.service.js";
import {
  CvImprovementsService,
  type HealthImprovementsPayload,
} from "../src/modules/cv-improvements/cv-improvements.service.js";
import { detectBuzzwords } from "../src/modules/cv-improvements/health/buzzwords.js";
import { detectCompleteness } from "../src/modules/cv-improvements/health/completeness.js";
import { detectDateFormats } from "../src/modules/cv-improvements/health/date-formats.js";
import { detectDuplicateSkills } from "../src/modules/cv-improvements/health/duplicate-skills.js";
import { detectAtsFormat } from "../src/modules/cv-improvements/health/ats-format.js";
import { HEALTH_TEMPLATE_VERSION } from "../src/modules/cv-improvements/health/index.js";
import { detectMissingKeywords } from "../src/modules/cv-improvements/health/missing-keywords.js";
import { detectQuantifiedAchievements } from "../src/modules/cv-improvements/health/quantified-achievements.js";
import { detectTechAdjacency } from "../src/modules/cv-improvements/health/tech-adjacency.js";
import { detectTenseConsistency } from "../src/modules/cv-improvements/health/tense-consistency.js";
import { detectWeakSummary } from "../src/modules/cv-improvements/health/weak-summary.js";
import type { HealthMatchReport } from "../src/modules/cv-improvements/health/types.js";
import { CvsService } from "../src/modules/cvs/cvs.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";

/* ---------------------------------------------------------------------------
 * Detector unit tests (spec 003 §FR-14, T5.4) — pure functions, small fixtures
 * ------------------------------------------------------------------------- */

function stated<T>(value: T): Evidenced<T> {
  return { value, status: "stated", confidence: 0.9, evidence: `evidence: ${String(value)}` };
}

function statedSkill(value: string) {
  return { ...stated(value), years: null, recency: null };
}

/** A fully covered profile (all completeness checks pass). */
function fullProfile(): CandidateProfile {
  const profile = emptyCandidateProfile();
  profile.headline.title = stated("Senior Backend Engineer");
  profile.headline.seniority = stated("senior" as const);
  profile.headline.total_years_experience = stated(8);
  profile.roles = [
    {
      title: stated("Backend Engineer"),
      company: stated("Acme Corp"),
      start: stated("2019"),
      end: stated("present"),
      industry: stated("SaaS"),
      scope: stated("team of 5"),
      is_current: true,
    },
  ];
  profile.skills.programming_languages = [statedSkill("TypeScript")];
  profile.skills.frameworks = [statedSkill("NestJS")];
  profile.skills.cloud_platforms = [statedSkill("AWS")];
  profile.skills.databases = [statedSkill("PostgreSQL")];
  profile.skills.devops_tools = [statedSkill("Docker")];
  profile.skills.other_technologies = [statedSkill("GraphQL")];
  profile.skills.soft_skills = [statedSkill("Mentoring")];
  profile.experience.industries = [stated("SaaS")];
  profile.experience.domains = [stated("fintech")];
  profile.experience.leadership = stated(true);
  profile.education = [
    { degree: stated("BSc Computer Science"), institution: stated("TU Berlin"), year: stated(2016) },
  ];
  profile.languages = [{ language: stated("English"), level: stated("fluent" as const) }];
  profile.location.current = stated("Berlin");
  profile.certifications = [
    { name: stated("AWS SAA"), issuer: stated("Amazon"), year: stated(2022) },
  ];
  profile.summary_quality = 100;
  return profile;
}

describe("completeness detector (spec 003 §FR-14, P0)", () => {
  it("no profile yet → info item pointing at the pipeline", () => {
    const item = detectCompleteness(null);
    expect(item.detector).toBe("completeness");
    expect(item.severity).toBe("info");
    expect(item.title).toBe("No candidate profile yet");
  });

  it("surfaces summary_quality and lists the top unknown fields as to-dos", () => {
    const profile = emptyCandidateProfile();
    profile.summary_quality = 12;
    const item = detectCompleteness(profile);
    expect(item.severity).toBe("warning");
    expect(item.title).toBe("Profile completeness: 12/100");
    // Top gaps by summary-quality weight, paths + human labels.
    expect(item.examples).toEqual([
      "headline.title — Current job title",
      "headline.seniority — Seniority level",
      "headline.total_years_experience — Total years of experience",
      "roles — Work experience (roles with title and company)",
      "skills.programming_languages — Programming languages",
    ]);
  });

  it("a fully covered profile is informational with no to-dos", () => {
    const item = detectCompleteness(fullProfile());
    expect(item.severity).toBe("info");
    expect(item.title).toBe("Profile completeness: 100/100");
    expect(item.examples).toBeUndefined();
  });
});

/* ---------------- missing keywords ---------------- */

function matchReport(
  jobId: string,
  requirements: { id: string; text: string; verdict: VerdictValue; importance?: RequirementImportance }[],
): HealthMatchReport {
  return {
    jobId,
    verdicts: requirements.map((req) => ({
      requirement_id: req.id,
      verdict: req.verdict,
      confidence: 1,
      candidate_evidence: [],
      reasoning: "test",
    })),
    requirements: requirements.map((req) => ({
      id: req.id,
      text: req.text,
      category: "skill" as const,
      importance: req.importance ?? "must_have",
    })),
  };
}

describe("missing-keywords detector (spec 003 §FR-14, P0)", () => {
  it("no match reports → info item instead of silence", () => {
    const items = detectMissingKeywords([], new Set(), "any cv text");
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.title).toBe("No match reports yet");
  });

  it("aggregates a must-have gap across distinct jobs with the job count", () => {
    const reports = [
      matchReport("job-1", [{ id: "r1", text: "5+ years of Docker experience", verdict: "missing" }]),
      matchReport("job-2", [{ id: "r1", text: "Docker required", verdict: "unknown" }]),
      matchReport("job-3", [{ id: "r1", text: "Experience with Docker and CI/CD", verdict: "missing" }]),
      matchReport("job-4", [{ id: "r1", text: "Strong Python skills", verdict: "match" }]),
      matchReport("job-5", [{ id: "r1", text: "Strong Python skills", verdict: "match" }]),
    ];
    const items = detectMissingKeywords(reports, new Set([canonicalizeSkill("python")]), "Python developer CV");
    const docker = items.find((item) => item.title.startsWith("Docker"));
    expect(docker).toBeDefined();
    expect(docker?.severity).toBe("warning");
    expect(docker?.title).toBe("Docker — required by 3 of your 5 matched jobs");
    // Phrased as a question/to-do, never auto-added.
    expect(docker?.detail).toContain("Do you have real experience");
    expect(docker?.detail).toContain("nothing is added automatically");
  });

  it("ignores nice-to-have requirements and matched verdicts", () => {
    const reports = [
      matchReport("job-1", [
        { id: "r1", text: "Docker experience", verdict: "missing", importance: "nice_to_have" },
        { id: "r2", text: "Kubernetes experience", verdict: "match" },
      ]),
    ];
    expect(detectMissingKeywords(reports, new Set(), "")).toEqual([]);
  });

  it("folds aliases — 'k8s' in the profile covers a 'Kubernetes' requirement", () => {
    const reports = [
      matchReport("job-1", [{ id: "r1", text: "Kubernetes experience required", verdict: "missing" }]),
    ];
    expect(
      detectMissingKeywords(reports, new Set([canonicalizeSkill("k8s")]), ""),
    ).toEqual([]);
  });

  it("a skill mentioned anywhere in the CV text is not a gap", () => {
    const reports = [
      matchReport("job-1", [{ id: "r1", text: "Docker experience required", verdict: "missing" }]),
    ];
    expect(
      detectMissingKeywords(reports, new Set(), "Deployed services with Docker daily."),
    ).toEqual([]);
  });

  it("two reports for the same job count once (latest wins)", () => {
    const reports = [
      matchReport("job-1", [{ id: "r1", text: "Docker required", verdict: "missing" }]),
      matchReport("job-1", [{ id: "r1", text: "Terraform required", verdict: "missing" }]),
    ];
    const items = detectMissingKeywords(reports, new Set(), "");
    expect(items.map((item) => item.title)).toEqual([
      "Docker — required by 1 of your 1 matched jobs",
    ]);
  });
});

/* ---------------- duplicate skills ---------------- */

describe("duplicate-skills detector (spec 003 §FR-14, P1)", () => {
  it("folds aliases within and across skill groups ('JS' and 'JavaScript')", () => {
    const profile = emptyCandidateProfile();
    profile.skills.programming_languages = [statedSkill("JS"), statedSkill("JavaScript")];
    profile.skills.frameworks = [statedSkill("react.js"), statedSkill("React")];
    const item = detectDuplicateSkills(profile);
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("warning");
    expect(item?.examples).toContain('"JS" and "JavaScript" — keep "JavaScript"');
    expect(item?.examples).toHaveLength(2);
  });

  it("distinct skills → no item", () => {
    const profile = emptyCandidateProfile();
    profile.skills.programming_languages = [statedSkill("TypeScript"), statedSkill("Python")];
    expect(detectDuplicateSkills(profile)).toBeNull();
  });
});

/* ---------------- tense consistency ---------------- */

const TENSE_MIXED_CV = [
  "Acme Corp — Backend Engineer (2019–2024)",
  "- Managed the payment service.",
  "- Manages the deployment pipeline.",
  "- Maintained internal tooling.",
  "",
  "Globex — Intern (2017–2018)",
  "- Built prototype dashboards.",
  "- Wrote unit tests.",
].join("\n");

describe("tense-consistency detector (spec 003 §FR-14, P1)", () => {
  it("flags a role whose bullets mix past and present tense, with counts + examples", () => {
    const item = detectTenseConsistency(TENSE_MIXED_CV);
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("warning");
    expect(item?.detail).toContain("1 bullet section(s)");
    expect(item?.detail).toContain("(4 bullets)"); // past total
    expect(item?.detail).toContain("(1 bullets)"); // present total
    expect(item?.detail).toContain("Heuristic"); // honest about the method
    expect(item?.examples).toEqual([
      "Managed the payment service.",
      "Manages the deployment pipeline.",
    ]);
  });

  it("consistent past tense → no item", () => {
    expect(
      detectTenseConsistency("- Managed the service.\n- Built dashboards.\n- Wrote tests."),
    ).toBeNull();
  });
});

/* ---------------- date formats ---------------- */

describe("date-format detector (spec 003 §FR-14, P1)", () => {
  it("reports every format family found when the CV mixes them", () => {
    const item = detectDateFormats(
      "Acme Corp 01/2020 - 03/2021\nGlobex January 2022 - March 2023",
    );
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("warning");
    expect(item?.detail).toContain("MM/YYYY ×2");
    expect(item?.detail).toContain("Month YYYY ×2");
    expect(item?.examples).toContain("01/2020 (MM/YYYY)");
    expect(item?.examples).toContain("January 2022 (Month YYYY)");
  });

  it("a single format family → no item", () => {
    expect(detectDateFormats("Acme 01/2020 - 03/2021, then 05/2021 - 09/2022")).toBeNull();
  });

  it("'May 2020' counts as a long month, never double-counted as short", () => {
    const item = detectDateFormats("Acme May 2020 - June 2021, Globex 2022-01 - 2022-12");
    expect(item?.detail).toContain("Month YYYY ×2");
    expect(item?.detail).toContain("YYYY-MM ×2");
    expect(item?.detail).not.toContain("Mon YYYY");
  });
});

/* ---------------- buzzwords ---------------- */

describe("buzzwords detector (spec 003 §FR-14, P1)", () => {
  it("flags one buzzword used twice (case-insensitive, hyphen/space folded)", () => {
    const item = detectBuzzwords("I am a Team Player. A real team-player at heart.");
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("warning");
    expect(item?.detail).toContain('"team-player" ×2');
  });

  it("flags three different buzzwords used once each", () => {
    const item = detectBuzzwords("A results-driven guru and certified rockstar.");
    expect(item).not.toBeNull();
    expect(item?.title).toContain("3 occurrences");
  });

  it("a single buzzword occurrence → no item", () => {
    expect(detectBuzzwords("Sometimes called a testing guru.")).toBeNull();
  });

  it("the list is configurable", () => {
    expect(detectBuzzwords(" synergy synergy ", ["synergy"])).not.toBeNull();
    expect(detectBuzzwords(" synergy synergy ", ["rockstar"])).toBeNull();
  });
});

/* ---------------- quantified achievements ---------------- */

const QUANT_CV = [
  "- Managed the payment service.",
  "- Helped with on-call rotations.",
  "- Reduced latency by 40%.",
  "- Led the 2019 migration.",
  "- Improved dashboards.",
].join("\n");

describe("quantified-achievements detector (spec 003 §FR-14, P1)", () => {
  it("reports the ratio and the weakest unquantified bullets as examples", () => {
    const item = detectQuantifiedAchievements(QUANT_CV);
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("warning");
    expect(item?.title).toBe("20% of your bullets contain a number");
    // Weak-verb opener first; years ("2019") don't quantify a bullet.
    expect(item?.examples).toEqual([
      "Helped with on-call rotations.",
      "Managed the payment service.",
      "Led the 2019 migration.",
    ]);
    // Line references only — rewriting is the bullet improver's job.
    expect(item?.detail).toContain("bullet improver");
  });

  it("a healthy ratio is informational, not a warning", () => {
    const item = detectQuantifiedAchievements(
      "- Cut costs by $2M.\n- Grew traffic 3x.\n- Reduced latency by 40%.\n- Improved dashboards.",
    );
    expect(item?.severity).toBe("info");
    expect(item?.title).toBe("75% of your bullets contain a number");
  });

  it("fewer than 3 bullets → no item (ratio not meaningful)", () => {
    expect(detectQuantifiedAchievements("- Cut costs by $2M.\n- Improved things.")).toBeNull();
  });
});

/* ---------------- weak summary (T5.5) ---------------- */

const FIRST_PERSON_SUMMARY_CV = [
  "Jane Doe",
  "",
  "SUMMARY",
  "I am a backend engineer and my focus is payment systems.",
  "",
  "EXPERIENCE",
  "Acme Corp — Backend Engineer (2019–2024)",
  "- Built payment services.",
].join("\n");

const HEALTHY_SUMMARY_CV = [
  "Jane Doe",
  "",
  "Professional Summary:",
  "Backend engineer with 8 years in payments and platform work.",
  "",
  "Experience",
  "Acme Corp — Backend Engineer (2019–2024)",
  "- Built payment services.",
].join("\n");

describe("weak-summary detector (spec 003 §FR-14, P2/T5.5)", () => {
  it("no summary heading → info item pointing at the missing section", () => {
    const items = detectWeakSummary("Jane Doe\nAcme Corp — Engineer\n- Built things.");
    expect(items).toHaveLength(1);
    expect(items[0]?.detector).toBe("weak_summary");
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.title).toBe("No summary section found");
  });

  it("first-person summary flagged (warning) with the opening words as the example", () => {
    const items = detectWeakSummary(FIRST_PERSON_SUMMARY_CV);
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("warning");
    expect(items[0]?.title).toBe("Summary is written in the first person");
    expect(items[0]?.examples).toEqual([
      "I am a backend engineer and my focus is payment systems.",
    ]);
  });

  it("a summary over 80 words is flagged with the word count", () => {
    const body = Array.from({ length: 85 }, () => "word").join(" ");
    const items = detectWeakSummary(`SUMMARY\n${body}\nEXPERIENCE`);
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("warning");
    expect(items[0]?.title).toBe("Summary is too long (85 words)");
    // Example holds the first ~30 words, marked as truncated.
    expect(items[0]?.examples?.[0]?.endsWith("…")).toBe(true);
    expect(items[0]?.examples?.[0]?.split(" ").length).toBeLessThanOrEqual(31);
  });

  it("a short third-person summary (heading with colon, 'Professional Summary') → no items", () => {
    expect(detectWeakSummary(HEALTHY_SUMMARY_CV)).toEqual([]);
  });

  it("the section stops at the next heading — body text never swallows later sections", () => {
    // 85-word body, but everything after EXPERIENCE must not count towards it.
    const body = Array.from({ length: 85 }, () => "word").join(" ");
    const items = detectWeakSummary(`SUMMARY\n${body}\nEXPERIENCE\n${body}`);
    expect(items[0]?.title).toBe("Summary is too long (85 words)");
  });
});

/* ---------------- technology adjacency (T5.5) ---------------- */

describe("tech-adjacency detector (spec 003 §FR-14, P2/T5.5)", () => {
  it("Express without Node.js → question item, severity info, never an edit", () => {
    const items = detectTechAdjacency(new Set([canonicalizeSkill("Express")]));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.detector).toBe("tech_adjacency");
    expect(item.severity).toBe("info");
    expect(item.title).toBe("You list Express but not Node.js — do you use it?");
    expect(item.detail).toMatch(/nothing is changed automatically/i);
  });

  it("Node.js present (alias-folded) → no item", () => {
    expect(
      detectTechAdjacency(new Set([canonicalizeSkill("Express"), canonicalizeSkill("NodeJS")])),
    ).toEqual([]);
  });

  it("is a pure function — the input set is never mutated, even frozen", () => {
    const skills = Object.freeze(new Set(["express", "react", "django"]));
    const before = [...skills];
    const items = detectTechAdjacency(skills);
    expect(items.length).toBeGreaterThan(0); // node.js, javascript, python questions
    expect([...skills]).toEqual(before);
  });

  it("both skills of a pair listed → silence", () => {
    expect(
      detectTechAdjacency(new Set([canonicalizeSkill("Django"), canonicalizeSkill("Python")])),
    ).toEqual([]);
  });
});

/* ---------------- ATS format lint (T5.5) ---------------- */

const ATS_CLEAN_CV = [
  "Jane Doe",
  "Senior Backend Engineer",
  "",
  "Experience",
  "Acme Corp — Backend Engineer (2019–2024)",
  "- Built payment services.",
  "",
  "Education",
  "TU Berlin — BSc Computer Science",
  "",
  "Skills",
  "TypeScript, Node.js, PostgreSQL",
].join("\n");

const ATS_TABLE_CV = [
  "Jane Doe          │  jane@example.com",
  "Experience        │  Acme Corp — Backend Engineer",
  "Education         │  TU Berlin — BSc Computer Science",
  "Skills            │  TypeScript, Node.js, PostgreSQL",
].join("\n");

const ATS_NO_HEADERS_CV = [
  "Jane Doe",
  "Senior Backend Engineer",
  "Acme Corp 2019–2024, built payment services and led migrations.",
  "Globex 2017–2019, wrote unit tests and fixed bugs.",
  "TU Berlin, BSc Computer Science.",
  "TypeScript, Node.js, PostgreSQL, Docker.",
].join("\n");

describe("ats-format detector (spec 003 §FR-14, P2/T5.5)", () => {
  it("a clean single-column CV with standard headers → no items", () => {
    expect(detectAtsFormat(ATS_CLEAN_CV)).toEqual([]);
  });

  it("table-artifact sample fires; ≥2 signals escalate to warning", () => {
    const items = detectAtsFormat(ATS_TABLE_CV);
    const titles = items.map((item) => item.title);
    expect(titles).toContain("Table or column artifacts in the extracted text");
    // Table lines are not heading lines, so the missing-headers signal fires
    // too — two signals → every finding is a warning.
    expect(titles.some((title) => title.startsWith("Standard section headers not found"))).toBe(true);
    expect(items.every((item) => item.detector === "ats_format")).toBe(true);
    expect(items.every((item) => item.severity === "warning")).toBe(true);
    const table = items.find((item) => item.title.startsWith("Table or column"));
    expect(table?.detail).toContain("parse poorly in ATSs");
    expect(table?.detail).toContain("Heuristic");
  });

  it("missing-headers sample fires on its own, severity info (single signal)", () => {
    const items = detectAtsFormat(ATS_NO_HEADERS_CV);
    expect(items).toHaveLength(1);
    expect(items[0]?.detector).toBe("ats_format");
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.title).toBe(
      "Standard section headers not found: Experience, Education, Skills",
    );
  });

  it("page-number lines are flagged with the offending lines as examples", () => {
    const items = detectAtsFormat(`${ATS_CLEAN_CV}\nPage 1 of 2\nPage 2 of 2`);
    const pageItem = items.find((item) => item.title.startsWith("Possible page headers"));
    expect(pageItem).toBeDefined();
    expect(pageItem?.examples).toEqual(["Page 1 of 2", "Page 2 of 2"]);
  });
});

/* ---------------------------------------------------------------------------
 * Service tests — POST type=health stores a row with zero LLM cost
 * ------------------------------------------------------------------------- */

const USER = "user-1";
const TOKEN = "token";
const CV_ID = "11111111-1111-1111-1111-111111111111";
const CV_CONTENT_HASH = "cv-hash-health";

/** Health fixture CV: mixed dates, buzzwords, unquantified bullets, tense mix. */
const HEALTH_CV_TEXT = [
  "Jane Doe",
  "Senior Backend Engineer",
  "",
  "Acme Corp — Backend Engineer (01/2020 - 03/2021)",
  "- Managed the payment service.",
  "- Manages the deployment pipeline.",
  "- Helped with on-call rotations.",
  "- Reduced latency by 40%.",
  "Globex — Engineer (January 2022 - March 2023)",
  "- Built prototype dashboards.",
  "- A real team player and results-driven team player.",
].join("\n");

/** Stateful Supabase mock (same pattern as cv-improvements.spec.ts). */
type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[];
  private seq = 0;

  constructor(seed: Row[] = []) {
    this.rows = seed.map((row) => ({ ...row }));
  }

  nextId(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  }

  clock(): string {
    return new Date(1_700_000_000_000 + this.seq * 1000).toISOString();
  }
}

class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private mutation: { type: "insert" | "update"; payload?: Row } | null = null;
  private affected: Row[] | null = null;

  constructor(private readonly table: FakeTable) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  insert(payload: Row): this {
    this.mutation = { type: "insert", payload };
    return this;
  }

  update(payload: Row): this {
    this.mutation = { type: "update", payload };
    return this;
  }

  private finalize(): Row[] {
    if (this.affected) return this.affected;
    const mutation = this.mutation;
    if (mutation?.type === "insert") {
      const row = {
        id: this.table.nextId(),
        created_at: this.table.clock(),
        updated_at: this.table.clock(),
        ...mutation.payload,
      };
      this.table.rows.push(row);
      this.affected = [row];
    } else if (mutation?.type === "update") {
      const rows = this.matchRows();
      for (const row of rows) Object.assign(row, mutation.payload);
      this.affected = rows;
    } else {
      this.affected = this.matchRows();
    }
    return this.affected;
  }

  private matchRows(): Row[] {
    let rows = this.table.rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAsc ? 1 : -1;
      rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * dir);
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.finalize()[0] ?? null, error: null });
  }

  single(): Promise<{ data: Row | null; error: null }> {
    return this.maybeSingle();
  }

  then<T>(resolve: (value: { data: Row[]; error: null }) => T | PromiseLike<T>): Promise<T> {
    return Promise.resolve({ data: this.finalize(), error: null }).then(resolve);
  }
}

class StatefulClient {
  private readonly tables = new Map<string, FakeTable>();

  table(name: string): FakeTable {
    let table = this.tables.get(name);
    if (!table) {
      table = new FakeTable();
      this.tables.set(name, table);
    }
    return table;
  }

  seed(name: string, rows: Row[]): this {
    this.tables.set(name, new FakeTable(rows));
    return this;
  }

  from(name: string): FakeQuery {
    return new FakeQuery(this.table(name));
  }
}

interface Harness {
  service: CvImprovementsService;
  provider: LlmProvider;
  client: StatefulClient;
  usage: Array<Record<string, unknown>>;
}

function makeHarness(
  seeds: {
    cvText?: string | null;
    profile?: Row[];
    matches?: Row[];
    improvements?: Row[];
  } = {},
): Harness {
  const client = new StatefulClient()
    .seed("cvs", [
      {
        id: CV_ID,
        user_id: USER,
        name: "Pasted CV",
        file_path: null,
        extracted_text: seeds.cvText === undefined ? HEALTH_CV_TEXT : seeds.cvText,
        content_hash: CV_CONTENT_HASH,
        is_active: true,
        created_at: new Date(1_700_000_000_000).toISOString(),
      },
    ])
    .seed("cv_improvements", seeds.improvements ?? [])
    .seed("candidate_profiles", seeds.profile ?? [])
    .seed("job_matches", seeds.matches ?? []);

  const provider: LlmProvider = {
    complete: vi.fn(async () => ({ content: "{}", tokensIn: 1, tokensOut: 1 })),
    stream: vi.fn(),
  };
  const cache = new Map<string, unknown>();
  const usage: Array<Record<string, unknown>> = [];
  const serviceClient = {
    from(table: string) {
      if (table === "llm_cache") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({
                data: cache.has(key) ? { response: cache.get(key) } : null,
                error: null,
              }),
            }),
          }),
          upsert: async (row: { cache_key: string; response: unknown }) => {
            cache.set(row.cache_key, row.response);
            return { error: null };
          },
        };
      }
      if (table === "usage_records") {
        return {
          insert: async (row: Record<string, unknown>) => {
            usage.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  const supabase = {
    forUser: () => client,
    getServiceClient: () => serviceClient,
  } as unknown as SupabaseService;
  const ai = new AiService(supabase, provider);
  const cvs = new CvsService(supabase);
  return { service: new CvImprovementsService(supabase, ai, cvs), provider, client, usage };
}

function profileRow(profile: CandidateProfile): Row {
  return {
    id: "profile-1",
    user_id: USER,
    cv_id: CV_ID,
    version: 1,
    status: "ready",
    profile,
    stage_meta: {},
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

function v2MatchRow(jobId: string, result: Row): Row {
  return {
    id: `match-${jobId}`,
    user_id: USER,
    cv_id: CV_ID,
    job_id: jobId,
    score: 55,
    result,
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

/** Real stored v2 result: Docker must-have, verdict 'missing' (T3.4 shape). */
const DOCKER_MISSING_RESULT = {
  version: 2,
  score: 55,
  weights_version: "weights.v1",
  verdicts: [
    {
      requirement_id: "req-1",
      verdict: "missing",
      confidence: 1,
      candidate_evidence: [],
      reasoning: "Profile positively covers devops tools; Docker is not among them.",
    },
  ],
  requirements: [
    { id: "req-1", text: "5+ years of Docker experience", category: "skill", importance: "must_have" },
  ],
  low_confidence: false,
  unknown_must_have_share: 0,
  jd_low_confidence: false,
  template_versions: {},
};

function healthPayload(row: CvImprovement): HealthImprovementsPayload {
  return row.suggestions as HealthImprovementsPayload;
}

describe("CvImprovementsService health (spec 003 §FR-14, T5.4)", () => {
  it("POST type=health stores one row — zero provider calls, zero usage records", async () => {
    const { service, provider, client, usage } = makeHarness();

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const payload = healthPayload(row);

    expect(provider.complete).toHaveBeenCalledTimes(0);
    expect(usage).toEqual([]);
    expect(row.type).toBe("health");
    expect(row.template_version).toBe(HEALTH_TEMPLATE_VERSION);
    expect(payload.content_hash).toBe(CV_CONTENT_HASH);
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items) {
      expect(item.id).toBeTruthy();
      expect(item.status).toBe("pending");
      expect(["info", "warning"]).toContain(item.severity);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.detail.length).toBeGreaterThan(0);
    }
    // The fixture CV exercises the text detectors end to end.
    const detectors = payload.items.map((item) => item.detector);
    expect(detectors).toContain("completeness"); // no profile → info item
    expect(detectors).toContain("tense_consistency");
    expect(detectors).toContain("date_format_consistency");
    expect(detectors).toContain("buzzwords");
    expect(detectors).toContain("quantified_achievements");
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("repeat POST for the same CV content returns the stored row (content_hash reuse)", async () => {
    const { service, client, provider } = makeHarness();

    const first = await service.generateHealth(USER, TOKEN, CV_ID);
    const second = await service.generateHealth(USER, TOKEN, CV_ID);

    expect(second.id).toBe(first.id);
    expect(provider.complete).toHaveBeenCalledTimes(0);
    expect(client.table("cv_improvements").rows).toHaveLength(1);
  });

  it("a stored 'health.v1' row is NOT reused after the T5.5 version bump — a fresh v2 row is stored, then reused", async () => {
    const { service, client } = makeHarness({
      improvements: [
        {
          id: "old-health-row",
          user_id: USER,
          cv_id: CV_ID,
          type: "health",
          template_version: "health.v1",
          suggestions: { content_hash: CV_CONTENT_HASH, items: [] },
          created_at: new Date(1_600_000_000_000).toISOString(),
        },
      ],
    });

    const fresh = await service.generateHealth(USER, TOKEN, CV_ID);
    expect(fresh.id).not.toBe("old-health-row");
    expect(fresh.template_version).toBe(HEALTH_TEMPLATE_VERSION);
    expect(HEALTH_TEMPLATE_VERSION).toBe("health.v2");
    expect(client.table("cv_improvements").rows).toHaveLength(2);

    // The new v2 row itself follows the normal reuse rule.
    const again = await service.generateHealth(USER, TOKEN, CV_ID);
    expect(again.id).toBe(fresh.id);
    expect(client.table("cv_improvements").rows).toHaveLength(2);
  });

  it("the health run includes the T5.5 detectors end to end", async () => {
    const { service } = makeHarness();

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const detectors = healthPayload(row).items.map((item) => item.detector);

    // The fixture CV has no summary heading and no standard section headers.
    expect(detectors).toContain("weak_summary");
    expect(detectors).toContain("ats_format");
  });

  it("missing-keywords reflects a real stored v2 match report", async () => {
    const profile = fullProfile();
    // The fixture profile lists devops tools (Docker) — remove it so Docker
    // is a genuine gap, and scrub it from the CV text path as well.
    profile.skills.devops_tools = [statedSkill("Terraform")];
    const { service } = makeHarness({
      profile: [profileRow(profile)],
      matches: [v2MatchRow("job-1", DOCKER_MISSING_RESULT)],
    });

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const items = healthPayload(row).items;

    const docker = items.find((item) => item.detector === "missing_keywords" && item.severity === "warning");
    expect(docker?.title).toBe("Docker — required by 1 of your 1 matched jobs");
    // Old v1 results are ignored by the structural check.
    expect(items.every((item) => !item.title.includes("Terraform"))).toBe(true);
  });

  it("a skill the profile already lists (alias-folded) is not reported as missing", async () => {
    const profile = fullProfile(); // devops_tools includes Docker
    const { service } = makeHarness({
      profile: [profileRow(profile)],
      matches: [v2MatchRow("job-1", DOCKER_MISSING_RESULT)],
    });

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const keywords = healthPayload(row).items.filter((item) => item.detector === "missing_keywords");
    expect(keywords.every((item) => !item.title.startsWith("Docker"))).toBe(true);
  });

  it("duplicate detection folds aliases on the stored profile end to end", async () => {
    const profile = fullProfile();
    profile.skills.programming_languages = [statedSkill("JS"), statedSkill("JavaScript")];
    const { service } = makeHarness({ profile: [profileRow(profile)] });

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const duplicate = healthPayload(row).items.find((item) => item.detector === "duplicate_skills");
    expect(duplicate?.examples).toContain('"JS" and "JavaScript" — keep "JavaScript"');
  });

  it("completeness surfaces the stored summary_quality, not a recomputed one", async () => {
    const profile = fullProfile();
    profile.summary_quality = 87; // deliberately off the computed 100
    const { service } = makeHarness({ profile: [profileRow(profile)] });

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const completeness = healthPayload(row).items.find((item) => item.detector === "completeness");
    expect(completeness?.title).toBe("Profile completeness: 87/100");
  });

  it("PATCH dismisses a health item via status 'rejected'", async () => {
    const { service } = makeHarness();

    const row = await service.generateHealth(USER, TOKEN, CV_ID);
    const target = healthPayload(row).items[0]!;
    const updated = await service.updateSuggestionStatus(
      USER,
      TOKEN,
      CV_ID,
      row.id,
      target.id,
      "rejected",
    );

    expect(healthPayload(updated).items[0]?.status).toBe("rejected");
    expect(healthPayload(updated).items[1]?.status).toBe("pending");
  });

  it("another user's CV is a 404 — and still no LLM call", async () => {
    const { service, provider } = makeHarness();
    await expect(service.generateHealth("user-2", TOKEN, CV_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });

  it("a CV without text is rejected 422 before any work", async () => {
    const { service, provider } = makeHarness({ cvText: null });
    await expect(service.generateHealth(USER, TOKEN, CV_ID)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.complete).toHaveBeenCalledTimes(0);
  });
});
