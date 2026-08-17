import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDuration,
  percentOf,
  segmentWidth,
} from "@/ui/components/sync/sync-format";

/**
 * Edge cases first: every one of these functions is fed counts that come from a
 * run which may have read nothing at all, or crashed half-way. A tenant with an
 * empty Drive folder must not produce "NaN%" or a bar wider than its track.
 */

describe("percentOf", () => {
  it("has no answer when nothing entered the stage", () => {
    expect(percentOf(0, 0)).toBeNull();
    expect(percentOf(12, 0)).toBeNull();
    expect(percentOf(3, -5)).toBeNull();
  });

  it("has no answer for non-finite input", () => {
    expect(percentOf(Number.NaN, 10)).toBeNull();
    expect(percentOf(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds the share to a whole percent", () => {
    expect(percentOf(9_132, 14_987)).toBe(61);
    expect(percentOf(359, 367)).toBe(98);
    expect(percentOf(0, 100)).toBe(0);
  });
});

describe("segmentWidth", () => {
  it("collapses to zero instead of dividing by zero", () => {
    expect(segmentWidth(0, 0)).toBe("0%");
    expect(segmentWidth(5, 0)).toBe("0%");
    expect(segmentWidth(-5, 10)).toBe("0%");
    expect(segmentWidth(Number.NaN, 10)).toBe("0%");
  });

  it("clamps a segment that would overflow its track", () => {
    expect(segmentWidth(150, 100)).toBe("100%");
  });

  it("keeps full precision so segments still add up", () => {
    expect(segmentWidth(1, 3)).toBe(`${(1 / 3) * 100}%`);
  });
});

describe("formatCount", () => {
  it("marks a non-number rather than printing NaN", () => {
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("groups thousands the Vietnamese way", () => {
    expect(formatCount(14_987)).toBe("14.987");
  });
});

describe("formatDuration", () => {
  it("has no duration while the run has not finished", () => {
    expect(formatDuration("2026-08-17T10:24:32.000Z", null)).toBeNull();
  });

  it("refuses a finish time before the start (clock skew)", () => {
    expect(formatDuration("2026-08-17T10:24:32.000Z", "2026-08-17T10:24:31.000Z")).toBeNull();
  });

  it("refuses an unparsable timestamp instead of printing NaN", () => {
    expect(formatDuration("not-a-date", "2026-08-17T10:25:03.000Z")).toBeNull();
  });

  it("reads in seconds, then in minutes", () => {
    expect(formatDuration("2026-08-17T10:24:32.000Z", "2026-08-17T10:25:03.000Z")).toBe("31 giây");
    expect(formatDuration("2026-08-17T10:24:32.000Z", "2026-08-17T10:26:35.000Z")).toBe(
      "2 phút 3 giây",
    );
  });
});
