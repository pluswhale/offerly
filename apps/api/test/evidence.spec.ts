import { describe, expect, it } from "vitest";
import type { Evidenced } from "@offerly/types";
import {
  collectCandidateProfileEvidenced,
  EVIDENCE_UNVERIFIED_FLAG,
  UNVERIFIED_CONFIDENCE_CAP,
  verifyCandidateProfileEvidence,
} from "../src/modules/ai/evidence.js";
import { normalizeForMatch } from "../src/modules/ai/text.js";
import { CV_TEXT, fixtureProfile } from "./fixtures/cv-profile.fixture.js";

describe("normalizeForMatch (spec 003 §FR-1 S2)", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeForMatch("  Senior   Backend\n\nEngineer ")).toBe("senior backend engineer");
  });

  it("folds Unicode composition differences (NFC)", () => {
    const composed = "Café"; // é as a single code point
    const decomposed = "Café"; // e + combining acute accent
    expect(normalizeForMatch(composed)).toBe(normalizeForMatch(decomposed));
    expect(composed).not.toBe(decomposed); // genuinely different byte sequences
  });
});

describe("verifyCandidateProfileEvidence (T2.1)", () => {
  it("golden fixture: every stated item verifies verbatim (spec AC-1)", () => {
    const profile = fixtureProfile();
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(report.totalCount).toBeGreaterThan(0);
    expect(report.flagged).toEqual([]);
    expect(report.verifiedCount).toBe(report.totalCount);
  });

  it("accepts quotes differing only in case and whitespace", () => {
    const profile = fixtureProfile();
    const title = profile.headline.title;
    title.evidence = "senior   backend\nENGINEER";
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(report.flagged).toEqual([]);
    expect(title.confidence).toBe(0.9); // untouched
  });

  it("flags a fabricated quote and clamps its confidence to ≤0.4", () => {
    const profile = fixtureProfile();
    const frameworks = profile.skills.frameworks[0];
    if (!frameworks) throw new Error("fixture must have a framework");
    frameworks.evidence = "deployed Kubernetes clusters to AWS";
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(report.flagged).toEqual([
      {
        path: "skills.frameworks[0]",
        flag: EVIDENCE_UNVERIFIED_FLAG,
        value: "NestJS",
        evidence: "deployed Kubernetes clusters to AWS",
      },
    ]);
    expect(frameworks.confidence).toBeLessThanOrEqual(UNVERIFIED_CONFIDENCE_CAP);
    expect(report.verifiedCount).toBe(report.totalCount - 1);
  });

  it("clamps an already-low confidence without raising it", () => {
    const profile = fixtureProfile();
    const title = profile.headline.title;
    title.confidence = 0.2;
    title.evidence = "not in the document at all";
    verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(title.confidence).toBe(0.2);
  });

  it("skips user-sourced facts (source 'user', evidence null) — spec §FR-4", () => {
    const profile = fixtureProfile();
    const correction: Evidenced<string> = {
      value: "Staff Engineer",
      status: "stated",
      confidence: 1,
      evidence: null,
      source: "user",
    };
    profile.headline.title = correction;
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    expect(report.flagged).toEqual([]);
    expect(correction.confidence).toBe(1); // never clamped
    // The user fact is not counted as a verified AI extraction either.
    const entries = collectCandidateProfileEvidenced(profile);
    expect(entries.length).toBeGreaterThan(report.totalCount);
  });

  it("skips 'unknown' leaves entirely", () => {
    const profile = fixtureProfile();
    const report = verifyCandidateProfileEvidence(profile, CV_TEXT);
    const statedCount = collectCandidateProfileEvidenced(profile).filter(
      (e) => e.item.status === "stated",
    ).length;
    expect(report.totalCount).toBe(statedCount);
  });

  it("walks every leaf group of the profile", () => {
    const profile = fixtureProfile();
    const paths = collectCandidateProfileEvidenced(profile).map((e) => e.path);
    for (const expected of [
      "headline.title",
      "headline.total_years_experience",
      "roles[0].title",
      "roles[1].end",
      "skills.programming_languages[0]",
      "skills.databases", // group itself absent (empty array) — nothing to walk
      "experience.team_sizes_managed",
      "experience.leadership_scope",
      "education[0].year",
      "languages[0].level",
      "location.current",
      "location.remote_preference",
    ]) {
      if (expected === "skills.databases") {
        expect(paths.some((p) => p.startsWith("skills.databases"))).toBe(false);
      } else {
        expect(paths).toContain(expected);
      }
    }
  });
});
