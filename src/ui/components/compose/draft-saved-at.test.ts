import { describe, expect, it } from "vitest";

import { formatDraftSavedAt } from "@/ui/components/compose/DraftStatusBar";

/**
 * The draft status line's one formatted value. Split out of the component so
 * the rule can be tested without a DOM (`vitest.config.ts` runs in node).
 *
 * Every case builds its instants with the LOCAL constructor rather than a `Z`
 * string: the rule is about the operator's own calendar day, so a test pinned
 * to UTC would pass in Hanoi and fail in a CI box set to UTC-5.
 */
function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("formatDraftSavedAt", () => {
  // --- Edge cases first ------------------------------------------------------
  it("hands back an unparseable stamp untouched instead of printing garbage", () => {
    expect(formatDraftSavedAt("khong-phai-gio")).toBe("khong-phai-gio");
    expect(formatDraftSavedAt("")).toBe("");
  });

  it("keeps the date across a year boundary, one minute apart", () => {
    const saved = localDate(2025, 12, 31, 23, 59);
    const now = localDate(2026, 1, 1, 0, 0);
    expect(formatDraftSavedAt(saved.toISOString(), now)).toBe("31/12/2025 23:59");
  });

  it("shows the date for the same clock time on the day before", () => {
    // The regression: "Đã lưu nháp lúc 01:31" for a draft typed yesterday
    // reads as "a minute ago".
    const saved = localDate(2026, 8, 21, 1, 31);
    const now = localDate(2026, 8, 22, 1, 31);
    expect(formatDraftSavedAt(saved.toISOString(), now)).toBe("21/08/2026 01:31");
  });

  it("shows the date for the same day of a different month", () => {
    const saved = localDate(2026, 7, 22, 9, 5);
    const now = localDate(2026, 8, 22, 9, 5);
    expect(formatDraftSavedAt(saved.toISOString(), now)).toBe("22/07/2026 09:05");
  });

  // --- Happy path ------------------------------------------------------------
  it("shows the hour alone when the draft was saved today", () => {
    const saved = localDate(2026, 8, 22, 1, 31);
    const now = localDate(2026, 8, 22, 14, 2);
    expect(formatDraftSavedAt(saved.toISOString(), now)).toBe("01:31");
  });

  it("still says today at either end of the same calendar day", () => {
    const now = localDate(2026, 8, 22, 12, 0);
    expect(formatDraftSavedAt(localDate(2026, 8, 22, 0, 0).toISOString(), now)).toBe("00:00");
    expect(formatDraftSavedAt(localDate(2026, 8, 22, 23, 59).toISOString(), now)).toBe("23:59");
  });
});
