import { describe, expect, it } from "vitest";

import {
  CancelScheduledJobResponseSchema,
  MAX_SCHEDULE_AHEAD_MS,
  ScheduledJobEntrySchema,
  dayEndIso,
  dayStartIso,
  formatCountdown,
  groupScheduledByDay,
  hasScheduledFilter,
  isDateOnly,
  isHeldByPlatform,
  localDayKey,
  parseScheduledFilter,
  rescheduleBlockedReason,
  scheduleInputBounds,
  scheduledSearchParams,
  toDateTimeLocalValue,
  validateScheduleInput,
  type ScheduledJobEntry,
} from "./scheduled.schema";

/**
 * Edge cases first (CLAUDE.md §1): every helper here is fed garbage before it is
 * fed a happy path, because all of it runs on values typed by a human or read
 * out of a URL somebody edited by hand.
 */

const NOW = new Date("2026-08-13T10:00:00+07:00").getTime();

describe("isDateOnly", () => {
  it("rejects non-strings, wrong shapes and impossible days", () => {
    expect(isDateOnly(undefined)).toBe(false);
    expect(isDateOnly("")).toBe(false);
    expect(isDateOnly("2026-8-13")).toBe(false);
    expect(isDateOnly("13/08/2026")).toBe(false);
    expect(isDateOnly("2026-02-31")).toBe(false);
    expect(isDateOnly("2026-13-01")).toBe(false);
  });

  it("accepts a real calendar day", () => {
    expect(isDateOnly("2026-08-13")).toBe(true);
    expect(isDateOnly("2028-02-29")).toBe(true);
  });
});

describe("parseScheduledFilter", () => {
  it("falls back to no filter for junk instead of asking the server for junk", () => {
    const filter = parseScheduledFilter(
      new URLSearchParams({ channelId: "  ", from: "hôm qua", to: "2026-99-99" }),
    );
    expect(filter).toEqual({ channelId: null, from: null, to: null });
    expect(hasScheduledFilter(filter)).toBe(false);
  });

  it("drops an inverted window rather than returning an empty list forever", () => {
    const filter = parseScheduledFilter(
      new URLSearchParams({ from: "2026-08-20", to: "2026-08-10" }),
    );
    expect(filter.from).toBe("2026-08-20");
    expect(filter.to).toBeNull();
  });

  it("round-trips through the query-string builder", () => {
    const filter = parseScheduledFilter(
      new URLSearchParams({ channelId: "fbpage-a", from: "2026-08-13", to: "2026-08-14" }),
    );
    expect(scheduledSearchParams(filter).toString()).toBe(
      "channelId=fbpage-a&from=2026-08-13&to=2026-08-14",
    );
    expect(scheduledSearchParams({ channelId: null, from: null, to: null }).toString()).toBe("");
  });
});

describe("dayStartIso / dayEndIso", () => {
  it("returns null for anything that is not a real day", () => {
    expect(dayStartIso("nope")).toBeNull();
    expect(dayEndIso("2026-02-31")).toBeNull();
  });

  it("covers the whole selected day (end bound is the next midnight)", () => {
    const start = dayStartIso("2026-08-13");
    const end = dayEndIso("2026-08-13");
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(new Date(end as string).getTime() - new Date(start as string).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    // Local midnight, whatever the machine zone is.
    expect(new Date(start as string).getHours()).toBe(0);
  });
});

describe("validateScheduleInput", () => {
  it("refuses an empty field", () => {
    const result = validateScheduleInput("   ", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Chưa chọn giờ");
  });

  it("refuses an unparsable value", () => {
    const result = validateScheduleInput("13-08-2026 15:30", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("không hợp lệ");
  });

  it("refuses a time that already passed", () => {
    const past = toDateTimeLocalValue(new Date(NOW - 60_000));
    const result = validateScheduleInput(past, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("đã trôi qua");
  });

  it("refuses more than 30 days ahead, and accepts exactly the boundary", () => {
    const tooFar = toDateTimeLocalValue(new Date(NOW + MAX_SCHEDULE_AHEAD_MS + 2 * 60_000));
    const rejected = validateScheduleInput(tooFar, NOW);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("30 ngày");

    // The bound is minute-resolution, so compare on the minute the field offers.
    const { max } = scheduleInputBounds(NOW);
    const accepted = validateScheduleInput(max, NOW);
    expect(accepted.ok).toBe(true);
  });

  it("reads the field as LOCAL wall time and returns the instant", () => {
    const at = new Date(NOW + 2 * 60 * 60 * 1000);
    const result = validateScheduleInput(toDateTimeLocalValue(at), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Minute resolution: the seconds of `NOW` are dropped by the field.
      expect(Math.abs(result.delayMs - 2 * 60 * 60 * 1000)).toBeLessThan(60_000);
      expect(result.iso).toBe(new Date(result.at.getTime()).toISOString());
    }
  });
});

describe("formatCountdown", () => {
  it("never prints NaN", () => {
    expect(formatCountdown(Number.NaN)).toBe("—");
  });

  it("says overdue instead of a negative number", () => {
    expect(formatCountdown(-30_000)).toBe("quá giờ chưa tới 1 phút");
    expect(formatCountdown(-12 * 60_000)).toBe("quá giờ 12 phút");
  });

  it("scales from minutes to days", () => {
    expect(formatCountdown(30_000)).toBe("còn dưới 1 phút");
    expect(formatCountdown(45 * 60_000)).toBe("còn 45 phút");
    expect(formatCountdown(2 * 3_600_000 + 5 * 60_000)).toBe("còn 2 giờ 5 phút");
    expect(formatCountdown(3 * 3_600_000)).toBe("còn 3 giờ");
    expect(formatCountdown(2 * 86_400_000 + 3_600_000)).toBe("còn 2 ngày 1 giờ");
    expect(formatCountdown(2 * 86_400_000)).toBe("còn 2 ngày");
  });
});

describe("groupScheduledByDay", () => {
  const entry = (postJobId: string, scheduledAt: string): ScheduledJobEntry => ({
    postJobId,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    scheduledAt,
    startsInMs: 3_600_000,
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Chờ tới giờ đăng.",
    canReschedule: true,
    canCancel: true,
    createdAt: scheduledAt,
  });

  it("returns nothing for an empty page", () => {
    expect(groupScheduledByDay([])).toEqual([]);
  });

  it("keeps the timeline order and starts a new group per local day", () => {
    const first = new Date(2026, 7, 13, 9, 0).toISOString();
    const second = new Date(2026, 7, 13, 18, 0).toISOString();
    const third = new Date(2026, 7, 14, 8, 0).toISOString();

    const groups = groupScheduledByDay([
      entry("a", first),
      entry("b", second),
      entry("c", third),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].dayKey).toBe(localDayKey(first));
    expect(groups[0].items.map((item) => item.postJobId)).toEqual(["a", "b"]);
    expect(groups[1].items.map((item) => item.postJobId)).toEqual(["c"]);
  });
});

describe("a post Facebook is holding (E8.6)", () => {
  const heldRow = {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fbpage-a",
    format: "image_post",
    status: "scheduled_on_facebook",
    scheduledAt: "2026-08-14T02:00:00.000Z",
    startsInMs: 3_600_000,
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Facebook đã nhận lịch và sẽ tự đăng.",
    canReschedule: false,
    canCancel: true,
    createdAt: "2026-08-13T02:00:00.000Z",
  };

  it("parses instead of breaking the screen", () => {
    // The whole point of the mirror: the first handed-over post must render, not
    // blow the list up with a validation error.
    expect(ScheduledJobEntrySchema.safeParse(heldRow).success).toBe(true);
  });

  it("explains why 'Đổi giờ' is off, and points at Huỷ", () => {
    const reason = rescheduleBlockedReason(heldRow as ScheduledJobEntry);
    expect(reason).not.toBeNull();
    expect(reason).toContain("Facebook");
    expect(reason).toContain("Huỷ");
  });

  it("says nothing when the button is available or the row is past its hour", () => {
    expect(
      rescheduleBlockedReason({
        status: "queued",
        canReschedule: true,
        canCancel: true,
      }),
    ).toBeNull();
    // Overdue: neither action is offered and the cell already says so.
    expect(
      rescheduleBlockedReason({
        status: "queued",
        canReschedule: false,
        canCancel: false,
      }),
    ).toBeNull();
  });

  it("tells a queue-held post apart from a Facebook-held one", () => {
    expect(isHeldByPlatform("scheduled_on_facebook")).toBe(true);
    expect(isHeldByPlatform("queued")).toBe(false);
  });

  it("requires the cancel response to say whether Facebook's copy was deleted", () => {
    const withoutFlag = {
      tenantId: "00000000-0000-0000-0000-000000000001",
      postJobId: "job-1",
      batchId: "batch-1",
      channelId: "fbpage-a",
      status: "blocked",
      scheduledAt: "2026-08-14T02:00:00.000Z",
      queueEntryRemoved: false,
      userMessage: "Đã huỷ.",
    };
    // Without the flag the screen cannot tell "no queue entry to remove" from
    // "failed to remove the queue entry" and would raise a false alarm.
    expect(CancelScheduledJobResponseSchema.safeParse(withoutFlag).success).toBe(false);
    expect(
      CancelScheduledJobResponseSchema.safeParse({ ...withoutFlag, platformPostDeleted: true })
        .success,
    ).toBe(true);
  });
});
