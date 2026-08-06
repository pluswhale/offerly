import { describe, expect, it } from "vitest";
import {
  canonicalizePhrase,
  canonicalizeSkill,
  TECH_ALIASES,
} from "../src/modules/ai/matching/aliases.js";

describe("TECH_ALIASES (T3.2)", () => {
  it("folds the spec's canonical alias examples", () => {
    expect(canonicalizeSkill("K8s")).toBe(canonicalizeSkill("Kubernetes"));
    expect(canonicalizeSkill("Postgres")).toBe(canonicalizeSkill("PostgreSQL"));
    expect(canonicalizeSkill("JS")).toBe(canonicalizeSkill("JavaScript"));
    expect(canonicalizeSkill("TS")).toBe(canonicalizeSkill("TypeScript"));
    expect(canonicalizeSkill("Node")).toBe(canonicalizeSkill("Node.js"));
    expect(canonicalizeSkill("ReactJS")).toBe(canonicalizeSkill("React"));
    expect(canonicalizeSkill("Vue")).toBe(canonicalizeSkill("Vue.js"));
    expect(canonicalizeSkill("py")).toBe(canonicalizeSkill("Python"));
    expect(canonicalizeSkill("AWS")).toBe(canonicalizeSkill("Amazon Web Services"));
    expect(canonicalizeSkill("GCP")).toBe(canonicalizeSkill("Google Cloud"));
  });

  it("folds CI/CD variants onto one canonical", () => {
    const canonical = canonicalizeSkill("CI/CD");
    expect(canonicalizeSkill("cicd")).toBe(canonical);
    expect(canonicalizeSkill("Continuous Integration")).toBe(canonical);
  });

  it("keeps genuinely different technologies distinct", () => {
    expect(canonicalizeSkill("React")).not.toBe(canonicalizeSkill("React Native"));
    expect(canonicalizeSkill("C")).not.toBe(canonicalizeSkill("C++"));
    expect(canonicalizeSkill("C++")).not.toBe(canonicalizeSkill("C#"));
    expect(canonicalizeSkill("Spring")).not.toBe(canonicalizeSkill("Spring Boot"));
    expect(canonicalizeSkill("MongoDB")).not.toBe(canonicalizeSkill("MySQL"));
  });

  it("leaves unknown technologies untouched (normalized only)", () => {
    expect(canonicalizeSkill("  COBOL ")).toBe("cobol");
    expect(canonicalizeSkill("Haskell")).toBe("haskell");
  });

  it("is idempotent: canonical(canonical(x)) === canonical(x)", () => {
    const values = new Set(Object.values(TECH_ALIASES));
    for (const canonical of values) {
      expect(TECH_ALIASES[canonical]).toBe(canonical);
    }
  });

  it("has no alias mapping to two different canonicals (enforced at build)", () => {
    // buildAliasMap throws on collision; reaching this test means it did not.
    expect(Object.keys(TECH_ALIASES).length).toBeGreaterThan(80);
  });
});

describe("canonicalizePhrase (T3.2)", () => {
  it("folds aliases inside free text, longest match first", () => {
    expect(canonicalizePhrase("Experience with K8s and Postgres")).toBe(
      "experience with kubernetes and postgresql",
    );
    expect(canonicalizePhrase("Google Cloud Platform")).toBe(
      canonicalizeSkill("gcp"),
    );
    expect(canonicalizePhrase("Amazon Web Services (AWS)")).toContain(
      canonicalizeSkill("aws"),
    );
  });

  it("passes through tokens without aliases", () => {
    expect(canonicalizePhrase("Strong communication skills")).toBe(
      "strong communication skills",
    );
  });

  it("is idempotent on its own output", () => {
    const once = canonicalizePhrase("K8s, Node and AWS experience");
    expect(canonicalizePhrase(once)).toBe(once);
  });
});
