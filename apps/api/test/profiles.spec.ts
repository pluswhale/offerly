import { describe, expect, it } from "vitest";
import { mergeUserGoals } from "../src/modules/profiles/merge-user-goals.js";

describe("mergeUserGoals (spec 003 §FR-11, T4.4)", () => {
  it("starts from all-null goals when nothing is stored", () => {
    expect(mergeUserGoals(null, { target_location: "Berlin" })).toEqual({
      target_location: "Berlin",
      target_salary: null,
      priority: null,
    });
  });

  it("does not clobber unset keys", () => {
    const existing = {
      target_location: "Berlin",
      target_salary: { amount: 90000, currency: "EUR", period: "year" as const },
      priority: null,
    };
    const merged = mergeUserGoals(existing, { priority: "remote first" });
    expect(merged).toEqual({
      target_location: "Berlin",
      target_salary: { amount: 90000, currency: "EUR", period: "year" },
      priority: "remote first",
    });
  });

  it("clears a key on explicit null", () => {
    const existing = {
      target_location: "Berlin",
      target_salary: null,
      priority: "visa sponsorship",
    };
    expect(mergeUserGoals(existing, { priority: null })).toEqual({
      target_location: "Berlin",
      target_salary: null,
      priority: null,
    });
  });

  it("replaces a stored salary object wholesale", () => {
    const existing = {
      target_location: null,
      target_salary: { amount: 90000, currency: "EUR", period: "year" as const },
      priority: null,
    };
    const merged = mergeUserGoals(existing, {
      target_salary: { amount: 120000, currency: "USD", period: "year" },
    });
    expect(merged.target_salary).toEqual({ amount: 120000, currency: "USD", period: "year" });
  });
});
