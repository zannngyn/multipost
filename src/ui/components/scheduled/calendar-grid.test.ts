import { afterEach, describe, expect, it } from "vitest";

import {
  CALENDAR_COLUMNS,
  CALENDAR_ROWS,
  buildCalendarMonth,
  buildMonthMatrix,
  edgeNavigationDayKey,
  formatMonthHeading,
  groupJobsByDay,
  monthKeyOfDayKey,
  monthKeyOfMs,
  resolveMonthKey,
  sameDayInMonth,
  shiftDayKey,
  shiftMonthKey,
  todayKeyOfMs,
} from "./calendar-grid";
import type { ScheduledJobEntry } from "@/ui/schemas/scheduled.schema";

/**
 * Edge cases first (CLAUDE.md §1). Everything here runs on a value that came
 * from a URL somebody edited, from a server payload, or from the browser clock
 * on a day the zone shifts — so each helper is fed garbage before it is fed a
 * happy path.
 *
 * Every date is built with LOCAL parts (`new Date(y, m, d, …)`), never a UTC
 * literal, so the suite means the same thing in every machine zone.
 */

const CELLS = CALENDAR_ROWS * CALENDAR_COLUMNS;

/**
 * The machine zone, restored after any case that pins one.
 *
 * `buildMonthMatrix` reads the PROCESS zone through `new Date(y, m, d)`, so a
 * DST case has to set `process.env.TZ` — and has to put it back, or every case
 * after it would silently run in a zone it never asked for.
 */
const MACHINE_TZ = process.env.TZ;

afterEach(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = MACHINE_TZ;
});

function entry(overrides: Partial<ScheduledJobEntry> = {}): ScheduledJobEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    scheduledAt: new Date(2026, 7, 13, 9, 0).toISOString(),
    startsInMs: 3_600_000,
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Chờ tới giờ đăng.",
    canReschedule: true,
    canCancel: true,
    createdAt: new Date(2026, 7, 12, 9, 0).toISOString(),
    ...overrides,
  };
}

/** Local midnight of a day, as the instant the server would have sent. */
function isoAt(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("monthKeyOfDayKey / monthKeyOfMs / todayKeyOfMs", () => {
  it("refuses anything that is not a real day", () => {
    expect(monthKeyOfDayKey(undefined)).toBeNull();
    expect(monthKeyOfDayKey("")).toBeNull();
    expect(monthKeyOfDayKey("2026-02-31")).toBeNull();
    expect(monthKeyOfDayKey("2026-8-13")).toBeNull();
  });

  it("stays silent while the browser clock is unknown", () => {
    // 0 is what `useNowMs` reports on the server and for the first client frame.
    expect(monthKeyOfMs(0)).toBeNull();
    expect(monthKeyOfMs(Number.NaN)).toBeNull();
    expect(todayKeyOfMs(0)).toBe("");
    expect(todayKeyOfMs(-1)).toBe("");
  });

  it("reads the LOCAL month and day of an instant", () => {
    const now = new Date(2026, 7, 13, 23, 30).getTime();
    expect(monthKeyOfMs(now)).toBe("2026-08");
    expect(todayKeyOfMs(now)).toBe("2026-08-13");
  });
});

describe("shiftMonthKey", () => {
  it("returns junk unchanged instead of inventing a plausible month", () => {
    expect(shiftMonthKey("nope", 1)).toBe("nope");
    expect(shiftMonthKey("2026-13", 1)).toBe("2026-13");
    expect(shiftMonthKey("2026-08", Number.NaN)).toBe("2026-08");
  });

  it("crosses the year boundary in both directions", () => {
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-01", -13)).toBe("2024-12");
    expect(shiftMonthKey("2026-08", 0)).toBe("2026-08");
  });
});

describe("shiftDayKey", () => {
  it("returns junk unchanged", () => {
    expect(shiftDayKey("2026-02-31", 1)).toBe("2026-02-31");
    expect(shiftDayKey("2026-08-13", 1.5)).toBe("2026-08-13");
  });

  it("crosses month, year and the leap day", () => {
    expect(shiftDayKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDayKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDayKey("2026-08-13", -7)).toBe("2026-08-06");
  });
});

describe("edgeNavigationDayKey", () => {
  /**
   * The contract comes from `useGridFocus` (node_modules/@astryxdesign/core/
   * dist/hooks/useGridFocus.js, the ArrowUp/Down/Left/Right cases):
   *
   *   ArrowUp    -> onNavigateBefore(currentCol, columns)          offset = 7
   *   ArrowDown  -> onNavigateAfter(currentCol, columns)           offset = 7
   *   ArrowLeft  -> onNavigateBefore(wrapped destination col, 1)   offset = 1
   *   ArrowRight -> onNavigateAfter(wrapped destination col, 1)    offset = 1
   *
   * The two are NOT the same call: a vertical move keeps the caret in ITS OWN
   * column, so the destination is the cell one row outside the grid in that
   * column — not the day next to the corner of the grid. Handling both with
   * "first/last cell ± offset" is only right in the T2 (up) and CN (down)
   * columns and silently lands on the wrong day everywhere else.
   */

  // 01/08/2026 is a Saturday -> row 0 is [27/7 … 01/8 (col 5), 02/8 (col 6)].
  const SATURDAY_START = "2026-08";
  // 01/06/2026 is a Monday -> row 0 starts exactly on the 1st, no borrowed days.
  const MONDAY_START = "2026-06";
  // 01/11/2026 is a Sunday -> row 0 borrows six days from October.
  const SUNDAY_START = "2026-11";

  it("refuses a month that is not a month, and an offset it has no contract for", () => {
    expect(edgeNavigationDayKey("2026-13", "before", 0, 7)).toBeNull();
    expect(edgeNavigationDayKey("hôm nay", "after", 0, 1)).toBeNull();
    // Only 1 (horizontal) and 7 (vertical) are ever passed; anything else means
    // the vendor contract moved, and guessing would land on a wrong day.
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 0, 3)).toBeNull();
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 0, 0)).toBeNull();
  });

  it("refuses a column outside the week for a vertical move", () => {
    expect(edgeNavigationDayKey(SATURDAY_START, "before", -1, 7)).toBeNull();
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 7, 7)).toBeNull();
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 1.5, 7)).toBeNull();
  });

  it("ArrowUp from row 0 stays in its own column — every column, month starting Saturday", () => {
    const firstRow = buildMonthMatrix(SATURDAY_START)[0];
    for (let column = 0; column < CALENDAR_COLUMNS; column += 1) {
      expect(edgeNavigationDayKey(SATURDAY_START, "before", column, CALENDAR_COLUMNS)).toBe(
        shiftDayKey(firstRow[column], -7),
      );
    }
    // The regression the coordinator caught: 01/08 sits in column 5, and one
    // row up is 25/07 — not 20/07, which is what "first cell - 7" produces.
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 5, CALENDAR_COLUMNS)).toBe("2026-07-25");
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 0, CALENDAR_COLUMNS)).toBe("2026-07-20");
  });

  it("ArrowDown from the last row stays in its own column — every column", () => {
    const weeks = buildMonthMatrix(SATURDAY_START);
    const lastRow = weeks[weeks.length - 1];
    for (let column = 0; column < CALENDAR_COLUMNS; column += 1) {
      expect(edgeNavigationDayKey(SATURDAY_START, "after", column, CALENDAR_COLUMNS)).toBe(
        shiftDayKey(lastRow[column], 7),
      );
    }
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 2, CALENDAR_COLUMNS)).toBe("2026-09-09");
  });

  it("works the same when the 1st is a Monday and when it is a Sunday", () => {
    for (const monthKey of [MONDAY_START, SUNDAY_START]) {
      const weeks = buildMonthMatrix(monthKey);
      const lastRow = weeks[weeks.length - 1];
      for (let column = 0; column < CALENDAR_COLUMNS; column += 1) {
        expect(edgeNavigationDayKey(monthKey, "before", column, CALENDAR_COLUMNS)).toBe(
          shiftDayKey(weeks[0][column], -7),
        );
        expect(edgeNavigationDayKey(monthKey, "after", column, CALENDAR_COLUMNS)).toBe(
          shiftDayKey(lastRow[column], 7),
        );
      }
    }
    // 01/06/2026 is a Monday: one row above the first cell is 25/05.
    expect(edgeNavigationDayKey(MONDAY_START, "before", 0, CALENDAR_COLUMNS)).toBe("2026-05-25");
    // 01/11/2026 is a Sunday, drawn in column 6 of row 0; one row up is 25/10.
    expect(edgeNavigationDayKey(SUNDAY_START, "before", 6, CALENDAR_COLUMNS)).toBe("2026-10-25");
  });

  it("ArrowLeft off [0][0] is the day before the grid, whatever column the hook reports", () => {
    const first = buildMonthMatrix(SATURDAY_START)[0][0];
    // The hook reports the WRAPPED destination column (6) for this move; the
    // day arithmetic already lands there, so the column must not be applied.
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 6, 1)).toBe(shiftDayKey(first, -1));
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 0, 1)).toBe(shiftDayKey(first, -1));
    expect(edgeNavigationDayKey(SATURDAY_START, "before", 6, 1)).toBe("2026-07-26");
  });

  it("ArrowRight off [5][6] is the day after the grid, whatever column the hook reports", () => {
    const weeks = buildMonthMatrix(SATURDAY_START);
    const last = weeks[weeks.length - 1][CALENDAR_COLUMNS - 1];
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 0, 1)).toBe(shiftDayKey(last, 1));
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 3, 1)).toBe(shiftDayKey(last, 1));
    expect(edgeNavigationDayKey(SATURDAY_START, "after", 0, 1)).toBe("2026-09-07");
  });

  it("always lands on a day the grid it moves to actually contains", () => {
    // Whatever it returns has to be drawable, or the pending-focus effect waits
    // forever for a cell that never renders.
    for (const monthKey of [SATURDAY_START, MONDAY_START, SUNDAY_START]) {
      for (const direction of ["before", "after"] as const) {
        for (let column = 0; column < CALENDAR_COLUMNS; column += 1) {
          const target = edgeNavigationDayKey(monthKey, direction, column, CALENDAR_COLUMNS);
          expect(target).not.toBeNull();
          const targetMonth = monthKeyOfDayKey(target);
          expect(targetMonth).not.toBeNull();
          expect(buildMonthMatrix(targetMonth as string).flat()).toContain(target);
        }
      }
    }
  });
});

describe("sameDayInMonth", () => {
  it("refuses junk on either side", () => {
    expect(sameDayInMonth("nope", "2026-08")).toBeNull();
    expect(sameDayInMonth("2026-08-13", "2026-13")).toBeNull();
  });

  it("clamps to the last day instead of rolling into the next month", () => {
    expect(sameDayInMonth("2026-03-31", "2026-02")).toBe("2026-02-28");
    expect(sameDayInMonth("2028-03-31", "2028-02")).toBe("2028-02-29");
    expect(sameDayInMonth("2026-08-31", "2026-09")).toBe("2026-09-30");
    expect(sameDayInMonth("2026-08-13", "2026-09")).toBe("2026-09-13");
  });
});

describe("resolveMonthKey", () => {
  it("has nothing to anchor to while the clock is unknown", () => {
    expect(resolveMonthKey(null, null, 0)).toBeNull();
    expect(resolveMonthKey("2026-99", "nope", 0)).toBeNull();
  });

  it("prefers the URL, then the open day, then the clock", () => {
    const now = new Date(2026, 7, 13).getTime();
    expect(resolveMonthKey("2026-03", "2026-11-02", now)).toBe("2026-03");
    // A shared `?ngay=` link must land on the month that contains that day.
    expect(resolveMonthKey(null, "2026-11-02", now)).toBe("2026-11");
    expect(resolveMonthKey(null, null, now)).toBe("2026-08");
  });
});

describe("formatMonthHeading", () => {
  it("hands back a bad key rather than printing a wrong month", () => {
    expect(formatMonthHeading("2026-13")).toBe("2026-13");
  });

  it("drops the leading zero the way a person says it", () => {
    expect(formatMonthHeading("2026-08")).toBe("Tháng 8 năm 2026");
    expect(formatMonthHeading("2026-12")).toBe("Tháng 12 năm 2026");
  });
});

describe("buildMonthMatrix", () => {
  it("returns nothing for a key that is not a month", () => {
    expect(buildMonthMatrix("2026-00")).toEqual([]);
    expect(buildMonthMatrix("hôm nay")).toEqual([]);
  });

  it("is always six rows of seven, whatever the month", () => {
    for (const monthKey of ["2026-02", "2026-08", "2026-11", "2028-02"]) {
      const weeks = buildMonthMatrix(monthKey);
      expect(weeks).toHaveLength(CALENDAR_ROWS);
      for (const week of weeks) expect(week).toHaveLength(CALENDAR_COLUMNS);
    }
  });

  it("starts every row on a Monday", () => {
    for (const weeks of [buildMonthMatrix("2026-02"), buildMonthMatrix("2026-11")]) {
      for (const week of weeks) {
        const [year, month, day] = week[0].split("-").map(Number);
        expect(new Date(year, month - 1, day).getDay()).toBe(1);
      }
    }
  });

  it("covers 42 consecutive days with no gap and no repeat, in zones that actually shift the clock", () => {
    // The regression this guards: day maths done in milliseconds loses or
    // repeats a day on a DST boundary. Calendar arithmetic cannot.
    //
    // The machine running the suite is Asia/Saigon, which has no DST — so
    // naming "March" without pinning a zone would have guarded nothing. Node
    // re-reads `process.env.TZ` on the next `Date` operation, so the zone is
    // pinned per case and restored afterwards (see the `afterEach` above).
    //
    //   America/New_York  spring forward 08/03/2026, back 01/11/2026
    //   Australia/Sydney  back 05/04/2026, forward 04/10/2026 (southern half)
    //   Europe/Lisbon     UTC+0/+1, the boundary case at midnight
    //   Pacific/Chatham   a :45 offset — the shift is not a whole hour
    const zones = [
      "Asia/Saigon",
      "America/New_York",
      "Australia/Sydney",
      "Europe/Lisbon",
      "Pacific/Chatham",
    ];
    const months = ["2026-03", "2026-04", "2026-10", "2026-11"];

    for (const zone of zones) {
      process.env.TZ = zone;
      // Guard the guard: if Node ever stopped honouring a runtime TZ change,
      // every zone below would quietly be Asia/Saigon and this case would go
      // back to proving nothing.
      expect(
        new Intl.DateTimeFormat("en-US", { timeZone: undefined }).resolvedOptions().timeZone,
        "process.env.TZ is not being honoured — the DST cases would be vacuous",
      ).toBe(zone);

      for (const monthKey of months) {
        const flat = buildMonthMatrix(monthKey).flat();
        expect(new Set(flat).size, `${zone} ${monthKey}: a day is repeated`).toBe(CELLS);

        for (let index = 1; index < flat.length; index += 1) {
          const [year, month, day] = flat[index - 1].split("-").map(Number);
          const next = new Date(year, month - 1, day + 1);
          expect(flat[index], `${zone} ${monthKey}: gap after ${flat[index - 1]}`).toBe(
            `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`,
          );
        }
      }
    }
  });

  it("puts the day the clock shifts in the cell it belongs to, in every zone", () => {
    // Spot-checks the actual transition days rather than only the run of 42.
    const cases = [
      { zone: "America/New_York", monthKey: "2026-03", dayKey: "2026-03-08" },
      { zone: "America/New_York", monthKey: "2026-11", dayKey: "2026-11-01" },
      { zone: "Australia/Sydney", monthKey: "2026-04", dayKey: "2026-04-05" },
      { zone: "Australia/Sydney", monthKey: "2026-10", dayKey: "2026-10-04" },
      { zone: "Pacific/Chatham", monthKey: "2026-04", dayKey: "2026-04-05" },
    ];

    for (const { zone, monthKey, dayKey } of cases) {
      process.env.TZ = zone;
      const flat = buildMonthMatrix(monthKey).flat();
      expect(flat.filter((day) => day === dayKey), `${zone} ${dayKey}`).toHaveLength(1);
    }
  });

  it("keeps the 29th of a leap February and stops February at 28 otherwise", () => {
    expect(buildMonthMatrix("2028-02").flat()).toContain("2028-02-29");
    expect(buildMonthMatrix("2026-02").flat()).not.toContain("2026-02-29");
    expect(buildMonthMatrix("2026-02").flat()).toContain("2026-02-28");
  });

  it("keeps the 31st of a 31-day month", () => {
    expect(buildMonthMatrix("2026-08").flat()).toContain("2026-08-31");
  });

  it("borrows the leading days from the previous month when the 1st is a Sunday", () => {
    // 2026-11-01 is a Sunday: Monday-first means six borrowed October days.
    const first = buildMonthMatrix("2026-11")[0];
    expect(first[0]).toBe("2026-10-26");
    expect(first[6]).toBe("2026-11-01");
  });
});

describe("groupJobsByDay", () => {
  it("survives an empty page and a non-array", () => {
    expect(groupJobsByDay([]).byDay.size).toBe(0);
    // Defensive: the schema parses the payload, but a caller may still hand a
    // half-loaded value in, and a calendar must not throw on it.
    expect(groupJobsByDay(undefined as unknown as ScheduledJobEntry[]).byDay.size).toBe(0);
  });

  it("reports a job with no usable hour instead of dropping it", () => {
    const { byDay, skipped } = groupJobsByDay([
      entry({ postJobId: "no-hour", scheduledAt: "" }),
      entry({ postJobId: "bad-hour", scheduledAt: "hôm qua" }),
      entry({ postJobId: "good", scheduledAt: isoAt(2026, 8, 13, 9) }),
    ]);

    expect(byDay.get("2026-08-13")?.map((job) => job.postJobId)).toEqual(["good"]);
    expect(skipped.map((row) => row.postJobId)).toEqual(["no-hour", "bad-hour"]);
    for (const row of skipped) expect(row.reason.length).toBeGreaterThan(0);
  });

  it("puts a post at local midnight on the day that starts, not the one that ends", () => {
    const { byDay } = groupJobsByDay([entry({ scheduledAt: isoAt(2026, 8, 14, 0, 0) })]);
    expect(byDay.has("2026-08-14")).toBe(true);
    expect(byDay.has("2026-08-13")).toBe(false);
  });

  it("keeps the soonest-first order inside a day", () => {
    const { byDay } = groupJobsByDay([
      entry({ postJobId: "morning", scheduledAt: isoAt(2026, 8, 13, 8, 0) }),
      entry({ postJobId: "evening", scheduledAt: isoAt(2026, 8, 13, 20, 0) }),
    ]);
    expect(byDay.get("2026-08-13")?.map((job) => job.postJobId)).toEqual(["morning", "evening"]);
  });
});

describe("buildCalendarMonth", () => {
  const NOW = new Date(2026, 7, 13, 10, 0).getTime();

  it("renders an empty month as an empty month, not as a crash", () => {
    const month = buildCalendarMonth({ monthKey: "2026-08", items: [], nowMs: NOW });

    expect(month.weeks).toHaveLength(CALENDAR_ROWS);
    expect(month.totalInMonth).toBe(0);
    expect(month.totalOutsideMonth).toBe(0);
    expect(month.nearestDayKeyOutsideMonth).toBeNull();
    expect(month.skipped).toEqual([]);
  });

  it("has no weeks at all for a month key that is not a month", () => {
    const month = buildCalendarMonth({ monthKey: "2026-13", items: [], nowMs: NOW });
    expect(month.weeks).toEqual([]);
  });

  it("marks nothing as today or past while the browser clock is unknown", () => {
    const month = buildCalendarMonth({ monthKey: "2026-08", items: [], nowMs: 0 });
    const days = month.weeks.flatMap((week) => week.days);
    expect(days.some((day) => day.isToday)).toBe(false);
    expect(days.some((day) => day.isPast)).toBe(false);
  });

  it("tells today, the past and the borrowed edge days apart", () => {
    const days = buildCalendarMonth({
      monthKey: "2026-08",
      items: [],
      nowMs: NOW,
    }).weeks.flatMap((week) => week.days);

    const today = days.find((day) => day.dayKey === "2026-08-13");
    expect(today?.isToday).toBe(true);
    expect(today?.isPast).toBe(false);
    expect(today?.inMonth).toBe(true);

    expect(days.find((day) => day.dayKey === "2026-08-12")?.isPast).toBe(true);
    expect(days.find((day) => day.dayKey === "2026-08-14")?.isPast).toBe(false);
    // 2026-08-01 is a Saturday, so the row starts in July.
    expect(days.find((day) => day.dayKey === "2026-07-27")?.inMonth).toBe(false);
  });

  it("caps a busy day and reports the overflow instead of growing the cell", () => {
    const items = [1, 2, 3, 4, 5].map((index) =>
      entry({ postJobId: `job-${index}`, scheduledAt: isoAt(2026, 8, 20, 8 + index) }),
    );
    const day = buildCalendarMonth({ monthKey: "2026-08", items, nowMs: NOW })
      .weeks.flatMap((week) => week.days)
      .find((cell) => cell.dayKey === "2026-08-20");

    expect(day?.jobs).toHaveLength(5);
    expect(day?.visibleJobs).toHaveLength(3);
    expect(day?.overflowCount).toBe(2);
    // The full list still travels with the cell — the day panel shows all five.
    expect(day?.jobs.map((job) => job.postJobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
      "job-4",
      "job-5",
    ]);
  });

  it("refuses a nonsense cap rather than hiding every post", () => {
    const items = [entry({ scheduledAt: isoAt(2026, 8, 20, 9) })];
    const day = buildCalendarMonth({
      monthKey: "2026-08",
      items,
      nowMs: NOW,
      maxVisiblePerDay: 0,
    })
      .weeks.flatMap((week) => week.days)
      .find((cell) => cell.dayKey === "2026-08-20");

    expect(day?.visibleJobs).toHaveLength(1);
    expect(day?.overflowCount).toBe(0);
  });

  it("counts a job on a borrowed edge day against ITS month, not the one on screen", () => {
    // 2026-09-01 shows up in the trailing row of August, but it is a September
    // post: counting it in August would make the two numbers disagree.
    const month = buildCalendarMonth({
      monthKey: "2026-08",
      items: [
        entry({ postJobId: "aug", scheduledAt: isoAt(2026, 8, 31, 9) }),
        entry({ postJobId: "sep", scheduledAt: isoAt(2026, 9, 1, 9) }),
      ],
      nowMs: NOW,
    });

    expect(month.totalInMonth).toBe(1);
    expect(month.totalOutsideMonth).toBe(1);
    expect(month.nearestDayKeyOutsideMonth).toBe("2026-09-01");

    const borrowed = month.weeks
      .flatMap((week) => week.days)
      .find((cell) => cell.dayKey === "2026-09-01");
    // Still drawn in the cell, just not counted as August.
    expect(borrowed?.jobs).toHaveLength(1);
    expect(borrowed?.inMonth).toBe(false);
  });

  it("points at the SOONEST month that has posts when this one is empty", () => {
    const month = buildCalendarMonth({
      monthKey: "2026-08",
      items: [
        entry({ postJobId: "later", scheduledAt: isoAt(2026, 12, 4, 9) }),
        entry({ postJobId: "sooner", scheduledAt: isoAt(2026, 9, 4, 9) }),
      ],
      nowMs: NOW,
    });

    expect(month.totalInMonth).toBe(0);
    expect(month.totalOutsideMonth).toBe(2);
    expect(month.nearestDayKeyOutsideMonth).toBe("2026-09-04");
  });

  it("carries the unplaceable rows through so the screen can say so", () => {
    const month = buildCalendarMonth({
      monthKey: "2026-08",
      items: [entry({ postJobId: "broken", scheduledAt: "không phải giờ" })],
      nowMs: NOW,
    });

    expect(month.totalInMonth).toBe(0);
    expect(month.skipped).toHaveLength(1);
    expect(month.skipped[0].postJobId).toBe("broken");
  });
});
