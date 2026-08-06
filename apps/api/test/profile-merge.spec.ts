import { describe, expect, it } from "vitest";
import {
  applyUserCorrection,
  mergeUserCorrections,
} from "../src/modules/ai/profile-merge.js";
import {
  dropAtPath,
  getEvidencedAtPath,
  parseProfilePath,
} from "../src/modules/ai/profile-paths.js";
import { computeSummaryQuality } from "../src/modules/ai/summary-quality.js";
import { fixtureProfile } from "./fixtures/cv-profile.fixture.js";

describe("profile path utilities (T2.5)", () => {
  it("parses verifier-style paths and rejects malformed ones", () => {
    expect(parseProfilePath("skills.databases[0]")).toEqual(["skills", "databases", 0]);
    expect(parseProfilePath("headline.total_years_experience")).toEqual([
      "headline",
      "total_years_experience",
    ]);
    expect(parseProfilePath("roles[1].end")).toEqual(["roles", 1, "end"]);
    expect(parseProfilePath("")).toBeNull();
    expect(parseProfilePath("skills..databases")).toBeNull();
    expect(parseProfilePath("roles[abc]")).toBeNull();
  });

  it("resolves leaves and reports misses", () => {
    const profile = fixtureProfile();
    expect(getEvidencedAtPath(profile, "skills.frameworks[0]")?.value).toBe("NestJS");
    expect(getEvidencedAtPath(profile, "skills.databases[0]")).toBeNull(); // empty array
    expect(getEvidencedAtPath(profile, "headline.nope")).toBeNull();
    expect(getEvidencedAtPath(profile, "roles[0].is_current")).toBeNull(); // not Evidenced
  });

  it("drop removes array elements and turns scalars UNKNOWN", () => {
    const profile = fixtureProfile();
    expect(dropAtPath(profile, "skills.programming_languages[0]")).toBe(true);
    expect(profile.skills.programming_languages).toHaveLength(1);
    expect(profile.skills.programming_languages[0]?.value).toBe("JavaScript");

    expect(dropAtPath(profile, "headline.seniority")).toBe(true);
    expect(profile.headline.seniority).toEqual({
      value: null,
      status: "unknown",
      confidence: 0,
      evidence: null,
    });
  });
});

describe("applyUserCorrection (spec 003 §FR-4, T2.5)", () => {
  it("marks the field as a user statement: stated, confidence 1, no evidence", () => {
    const profile = fixtureProfile();
    expect(applyUserCorrection(profile, "headline.total_years_experience", 12)).toBe(true);
    expect(profile.headline.total_years_experience).toEqual({
      value: 12,
      status: "stated",
      confidence: 1,
      evidence: null,
      source: "user",
    });
  });

  it("corrects an array element in place, keeping skill metadata", () => {
    const profile = fixtureProfile();
    expect(applyUserCorrection(profile, "skills.programming_languages[0]", "TypeScript")).toBe(
      true,
    );
    const skill = profile.skills.programming_languages[0];
    expect(skill).toMatchObject({ value: "TypeScript", source: "user", confidence: 1 });
    expect(skill?.recency).toBe("Acme GmbH"); // metadata preserved
  });

  it("returns false for paths that do not exist (→ 400 at the endpoint)", () => {
    const profile = fixtureProfile();
    expect(applyUserCorrection(profile, "skills.databases[3]", "Postgres")).toBe(false);
    expect(applyUserCorrection(profile, "nonsense.path", "x")).toBe(false);
  });
});

describe("mergeUserCorrections (spec §FR-4: user wins on re-run, T2.5)", () => {
  it("preserves a user scalar over a freshly extracted value", () => {
    const previous = fixtureProfile();
    applyUserCorrection(previous, "headline.total_years_experience", 12);

    const next = fixtureProfile(); // fresh extraction says 9
    const preserved = mergeUserCorrections(previous, next);
    expect(preserved).toBe(1);
    expect(next.headline.total_years_experience).toMatchObject({
      value: 12,
      source: "user",
      confidence: 1,
      evidence: null,
    });
  });

  it("matches array elements by natural key, not index (reordered roles)", () => {
    const previous = fixtureProfile();
    applyUserCorrection(previous, "roles[0].company", "Acme SE");

    // Fresh extraction returns the same roles in reverse order.
    const next = fixtureProfile();
    next.roles.reverse();
    expect(next.roles[1]?.company.value).toBe("Acme GmbH");

    const preserved = mergeUserCorrections(previous, next);
    expect(preserved).toBe(1);
    const acme = next.roles.find((r) => r.title.value === "Senior Backend Engineer");
    expect(acme?.company).toMatchObject({ value: "Acme SE", source: "user" });
  });

  it("replaces a corrected skill in place by name and appends unmatched ones", () => {
    const previous = fixtureProfile();
    applyUserCorrection(previous, "skills.frameworks[0]", "NestJS"); // same name
    applyUserCorrection(previous, "skills.programming_languages[1]", "JS-renamed");

    const next = fixtureProfile();
    const preserved = mergeUserCorrections(previous, next);
    expect(preserved).toBe(2);
    // Same name → replaced at its position, not duplicated.
    expect(next.skills.frameworks).toHaveLength(1);
    expect(next.skills.frameworks[0]).toMatchObject({ value: "NestJS", source: "user" });
    // Renamed (new natural key) → appended; the AI extraction stays too.
    expect(next.skills.programming_languages).toHaveLength(3);
    expect(next.skills.programming_languages.at(-1)).toMatchObject({
      value: "JS-renamed",
      source: "user",
    });
  });

  it("returns 0 when nothing is user-sourced", () => {
    expect(mergeUserCorrections(fixtureProfile(), fixtureProfile())).toBe(0);
  });
});

describe("computeSummaryQuality (spec §FR-2, derived in S4)", () => {
  it("scores the fixture profile within 0–100 and rewards completeness", () => {
    const full = fixtureProfile();
    const score = computeSummaryQuality(full);
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(100);

    const sparse = fixtureProfile();
    sparse.headline.title = { value: null, status: "unknown", confidence: 0, evidence: null };
    sparse.roles = [];
    sparse.education = [];
    expect(computeSummaryQuality(sparse)).toBeLessThan(score);
  });
});
