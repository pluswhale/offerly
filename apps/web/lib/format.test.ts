import { describe, expect, it } from "vitest";

import { formatDate, formatRelative } from "./format";

const NOW = new Date("2026-06-15T12:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelative", () => {
  it("returns 'just now' under a minute", () => {
    expect(formatRelative(ago(0), NOW)).toBe("just now");
    expect(formatRelative(ago(59 * 1000), NOW)).toBe("just now");
  });

  it("returns minutes", () => {
    expect(formatRelative(ago(MINUTE), NOW)).toBe("1m ago");
    expect(formatRelative(ago(59 * MINUTE), NOW)).toBe("59m ago");
  });

  it("returns hours", () => {
    expect(formatRelative(ago(HOUR), NOW)).toBe("1h ago");
    expect(formatRelative(ago(23 * HOUR), NOW)).toBe("23h ago");
  });

  it("returns days", () => {
    expect(formatRelative(ago(DAY), NOW)).toBe("1d ago");
    expect(formatRelative(ago(29 * DAY), NOW)).toBe("29d ago");
  });

  it("falls back to formatDate at the 30-day boundary", () => {
    const iso = ago(30 * DAY);
    expect(formatRelative(iso, NOW)).toBe(formatDate(iso));
    expect(formatRelative(iso, NOW)).not.toMatch(/ago$/);
  });

  it("returns an em dash for an unparseable date", () => {
    expect(formatRelative("not-a-date")).toBe("—");
    expect(formatRelative("not-a-date", NOW)).toBe("—");
  });

  it("treats a future timestamp as 'just now'", () => {
    expect(formatRelative(new Date(NOW + DAY).toISOString(), NOW)).toBe("just now");
  });

  it("is deterministic for a supplied now", () => {
    const iso = ago(5 * MINUTE);
    expect(formatRelative(iso, NOW)).toBe(formatRelative(iso, NOW));
  });
});
