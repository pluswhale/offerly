import { describe, expect, it } from "vitest";
import type { Application, ApplicationStatus } from "@offerly/types";
import { daysInStage, derivePipelineInsights, isQuiet } from "./pipeline-insights";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;

function app(
  status: ApplicationStatus,
  changedDaysAgo = 0,
  overrides: Partial<Application> = {},
): Application {
  seq += 1;
  const changed = new Date(NOW.getTime() - changedDaysAgo * DAY_MS).toISOString();
  return {
    id: `app-${seq}`,
    user_id: "user-1",
    job_id: null,
    company: `Company ${seq}`,
    role: "Engineer",
    status,
    applied_at: null,
    notes: null,
    archived: false,
    status_changed_at: changed,
    created_at: changed,
    updated_at: changed,
    ...overrides,
  };
}

function repeat(n: number, status: ApplicationStatus): Application[] {
  return Array.from({ length: n }, () => app(status));
}

describe("derivePipelineInsights", () => {
  it("returns empty insights for no applications", () => {
    expect(derivePipelineInsights([], NOW)).toEqual({
      applied: 0,
      replyRate: null,
      interviewRate: null,
      avgDaysInStage: { saved: null, applied: null, interview: null },
      quiet: [],
    });
  });

  it("ignores archived applications entirely", () => {
    const insights = derivePipelineInsights(
      [app("applied", 30, { archived: true }), app("offer", 1, { archived: true })],
      NOW,
    );
    expect(insights.applied).toBe(0);
    expect(insights.replyRate).toBeNull();
    expect(insights.avgDaysInStage.applied).toBeNull();
    expect(insights.quiet).toEqual([]);
  });

  it("returns null rates when nothing has been applied", () => {
    const insights = derivePipelineInsights(repeat(3, "saved"), NOW);
    expect(insights.applied).toBe(0);
    expect(insights.replyRate).toBeNull();
    expect(insights.interviewRate).toBeNull();
  });

  it("computes conversion for a mixed pipeline", () => {
    const insights = derivePipelineInsights(
      [
        ...repeat(2, "saved"),
        ...repeat(4, "applied"),
        ...repeat(2, "interview"),
        ...repeat(1, "offer"),
        ...repeat(3, "rejected"),
      ],
      NOW,
    );
    expect(insights.applied).toBe(10);
    expect(insights.replyRate).toBeCloseTo(0.6);
    expect(insights.interviewRate).toBeCloseTo(0.3);
  });

  it("counts rejections as replies but not as interviews", () => {
    const insights = derivePipelineInsights(repeat(2, "rejected"), NOW);
    expect(insights.replyRate).toBe(1);
    expect(insights.interviewRate).toBe(0);
  });

  it("averages whole days in stage for open stages only", () => {
    const insights = derivePipelineInsights(
      [app("applied", 4), app("applied", 10), app("saved", 2), app("offer", 50)],
      NOW,
    );
    expect(insights.avgDaysInStage).toEqual({ saved: 2, applied: 7, interview: null });
  });

  it("lists quiet applications oldest status change first", () => {
    const newer = app("interview", 20);
    const older = app("applied", 40);
    const fresh = app("applied", 3);
    const insights = derivePipelineInsights([newer, fresh, older], NOW);
    expect(insights.quiet.map((a) => a.id)).toEqual([older.id, newer.id]);
  });
});

describe("isQuiet", () => {
  it("is not quiet at exactly 14 days, quiet one second later", () => {
    const exact = app("applied", 14);
    const later = app("applied", 14, {
      status_changed_at: new Date(NOW.getTime() - 14 * DAY_MS - 1000).toISOString(),
    });
    expect(isQuiet(exact, NOW)).toBe(false);
    expect(isQuiet(later, NOW)).toBe(true);
  });

  it("covers applied and interview only", () => {
    expect(isQuiet(app("applied", 60), NOW)).toBe(true);
    expect(isQuiet(app("interview", 60), NOW)).toBe(true);
    expect(isQuiet(app("saved", 60), NOW)).toBe(false);
    expect(isQuiet(app("offer", 60), NOW)).toBe(false);
    expect(isQuiet(app("rejected", 60), NOW)).toBe(false);
  });

  it("uses the status change time, not the last edit", () => {
    const edited = app("applied", 20, { updated_at: NOW.toISOString() });
    expect(isQuiet(edited, NOW)).toBe(true);
  });

  it("never treats archived applications as quiet", () => {
    expect(isQuiet(app("applied", 60, { archived: true }), NOW)).toBe(false);
  });
});

describe("daysInStage", () => {
  it("floors to whole days", () => {
    expect(daysInStage(app("applied", 5.9), NOW)).toBe(5);
  });

  it("clamps future timestamps to zero", () => {
    expect(daysInStage(app("applied", -2), NOW)).toBe(0);
  });
});
