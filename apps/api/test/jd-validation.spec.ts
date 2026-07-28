import { describe, expect, it } from "vitest";
import { isLowConfidenceJd, looksLikeJobDescription } from "../src/modules/jobs/jd-validation.js";

const REAL_JD = `
Senior Frontend Engineer — Acme Corp

About the role: we are looking for a senior frontend engineer to join our team.
Responsibilities:
- Build and maintain our React application
- Work with designers to ship delightful UX
- Mentor junior engineers
Requirements:
- 5+ years of experience with TypeScript and React
- Experience with testing and CI
- A track record of shipping products users love
Benefits: competitive salary, remote-first, generous vacation policy and learning budget.
`;

describe("JD heuristic validation (T6.1)", () => {
  it("accepts a real job description", () => {
    expect(looksLikeJobDescription(REAL_JD).valid).toBe(true);
  });

  it("rejects lorem ipsum", () => {
    const lorem =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit.";
    const result = looksLikeJobDescription(lorem);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects very short pastes", () => {
    expect(looksLikeJobDescription("React dev needed").valid).toBe(false);
  });

  it("rejects long text without JD signals", () => {
    const filler = "The weather today is pleasant. ".repeat(30);
    expect(looksLikeJobDescription(filler).valid).toBe(false);
  });

  it("flags short JDs as low-confidence for match scoring (T6.2)", () => {
    expect(isLowConfidenceJd("Short job post with requirements")).toBe(true);
    expect(isLowConfidenceJd(REAL_JD)).toBe(false);
  });
});
