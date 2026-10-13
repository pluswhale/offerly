import { describe, expect, it } from "vitest";
import type { Application } from "@offerly/types";
import { STALE_DAYS, derivePipelineInsights } from "./pipeline-insights";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;

const daysAgo = (days: number, extraMs = 0): string =>
  new Date(NOW.getTime() - days * DAY_MS - extraMs).toISOString();

const app = (over: Partial<Application> = {}): Application => ({
  id: `app-${++seq}`,
  user_id: "u1",
  job_id: null,
  company: "Acme",
  role: "Engineer",
  status: "saved",
  applied_at: null,
  notes: null,
  archived: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("derivePipelineInsights", () => {
  it("returns an empty, non-throwing result for no applications", () => {
    const result = derivePipelineInsights([], NOW);

    expect(result.total).toBe(0);
    expect(result.replyRate).toBeNull();
    expect(result.interviewRate).toBeNull();
    expect(result.staleCount).toBe(0);
    expect(result.staleApplications).toEqual([]);
    expect(result.funnel.map((stage) => stage.count)).toEqual([0, 0, 0, 0]);
    expect(result.funnel.map((stage) => stage.conversionFromPrevious)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("ignores archived applications entirely", () => {
    const result = derivePipelineInsights(
      [
        app({ archived: true, status: "offer" }),
        app({ archived: true, status: "applied", updated_at: daysAgo(90) }),
      ],
      NOW,
    );

    expect(result).toEqual(derivePipelineInsights([], NOW));
  });

  it("reports null rates, not zero, when nothing has been applied to", () => {
    const result = derivePipelineInsights(
      [app({ status: "saved" }), app({ status: "saved" })],
      NOW,
    );

    expect(result.total).toBe(2);
    expect(result.replyRate).toBeNull();
    expect(result.interviewRate).toBeNull();
    expect(result.funnel.map((stage) => stage.conversionFromPrevious)).toEqual([
      null,
      0,
      null,
      null,
    ]);
  });

  it("counts rejected as applied and as a reply, but not as an interview", () => {
    const result = derivePipelineInsights(
      [app({ status: "rejected" }), app({ status: "applied" })],
      NOW,
    );

    expect(result.funnel.map((stage) => stage.count)).toEqual([2, 2, 0, 0]);
    expect(result.replyRate).toBe(0.5);
    expect(result.interviewRate).toBe(0);
  });

  it("treats exactly 14 days as fresh and 14 days plus one second as stale", () => {
    const onBoundary = app({ status: "applied", updated_at: daysAgo(STALE_DAYS) });
    const pastBoundary = app({
      status: "applied",
      updated_at: daysAgo(STALE_DAYS, 1000),
    });

    expect(derivePipelineInsights([onBoundary], NOW).staleCount).toBe(0);
    expect(derivePipelineInsights([pastBoundary], NOW).staleCount).toBe(1);
  });

  it("lists at most three stale applications, oldest first, ignoring replied statuses", () => {
    const oldest = app({ status: "applied", updated_at: daysAgo(90) });
    const middle = app({ status: "saved", updated_at: daysAgo(60) });
    const newer = app({ status: "applied", updated_at: daysAgo(30) });
    const newest = app({ status: "saved", updated_at: daysAgo(20) });
    const replied = [
      app({ status: "interview", updated_at: daysAgo(400) }),
      app({ status: "offer", updated_at: daysAgo(400) }),
      app({ status: "rejected", updated_at: daysAgo(400) }),
    ];
    const input = [newest, ...replied, oldest, newer, middle];

    const result = derivePipelineInsights(input, NOW);

    expect(result.staleCount).toBe(4);
    expect(result.staleApplications.map((a) => a.id)).toEqual([
      oldest.id,
      middle.id,
      newer.id,
    ]);
    expect(input[0]).toBe(newest);
  });

  it("never treats a future updated_at as stale", () => {
    const result = derivePipelineInsights(
      [app({ status: "applied", updated_at: daysAgo(-5) })],
      NOW,
    );

    expect(result.staleCount).toBe(0);
  });

  it("derives funnel counts and conversions from a mixed pipeline", () => {
    const input = [
      ...Array.from({ length: 4 }, () => app({ status: "saved" })),
      ...Array.from({ length: 3 }, () => app({ status: "applied" })),
      ...Array.from({ length: 2 }, () => app({ status: "interview" })),
      app({ status: "offer" }),
      ...Array.from({ length: 2 }, () => app({ status: "rejected" })),
    ];

    const result = derivePipelineInsights(input, NOW);

    expect(result.total).toBe(12);
    expect(result.funnel.map((stage) => stage.count)).toEqual([12, 8, 3, 1]);
    expect(result.funnel.map((stage) => stage.conversionFromPrevious)).toEqual([
      null,
      8 / 12,
      3 / 8,
      1 / 3,
    ]);
    expect(result.replyRate).toBe(5 / 8);
    expect(result.interviewRate).toBe(3 / 8);
  });
});
