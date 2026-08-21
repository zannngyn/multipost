import {
  isDateOnly,
  isMonthKey,
  localDayKey,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";

/**
 * The arithmetic behind the month grid of "Bài đã hẹn" (E8/E10) — pure, so the
 * awkward parts (leap day, a month that needs six rows, a post at midnight,
 * the day the clock shifts) are testable without a browser.
 *
 * Two rules this file exists to keep:
 *
 *  1. NEVER do date maths in milliseconds. `+ 86_400_000` is one hour wrong on
 *     the two days a year a zone shifts, which silently moves a post into the
 *     neighbouring cell. Every step here goes through `new Date(y, m, d)` with
 *     an overflowing day number, which the runtime normalises on the CALENDAR.
 *  2. NEVER invent a second way to name a day. The day key and the day heading
 *     come from `scheduled.schema` (`localDayKey`, `formatDayHeading`) so the
 *     list and the calendar can never disagree about which day a post is on.
 */

/** Monday first: a Vietnamese wall calendar starts on Thứ Hai, not Sunday. */
export const CALENDAR_WEEKDAYS = [
  { short: "T2", full: "Thứ Hai" },
  { short: "T3", full: "Thứ Ba" },
  { short: "T4", full: "Thứ Tư" },
  { short: "T5", full: "Thứ Năm" },
  { short: "T6", full: "Thứ Sáu" },
  { short: "T7", full: "Thứ Bảy" },
  { short: "CN", full: "Chủ Nhật" },
] as const;

export const CALENDAR_COLUMNS = 7;
/** Fixed six rows: a grid that changes height between months makes the page jump. */
export const CALENDAR_ROWS = 6;
/** Month cells are for scanning, not reading (core-calendar-view rule 1). */
export const CALENDAR_MAX_VISIBLE_PER_DAY = 3;

export interface CalendarDayCell {
  /** "YYYY-MM-DD" in the operator's own zone. */
  dayKey: string;
  dayOfMonth: number;
  /** False for the leading/trailing days borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** Strictly before today. Unknown (and therefore false) until the browser clock is. */
  isPast: boolean;
  jobs: ScheduledJobEntry[];
  visibleJobs: ScheduledJobEntry[];
  /** How many of `jobs` did not fit — the "+N bài nữa" number. */
  overflowCount: number;
}

export interface CalendarWeek {
  key: string;
  days: CalendarDayCell[];
}

/** A job that could not be placed, and why — never dropped in silence. */
export interface SkippedCalendarJob {
  postJobId: string;
  reason: string;
}

export interface CalendarMonth {
  monthKey: string;
  weeks: CalendarWeek[];
  /** Jobs sitting in a cell of THIS month (excludes the borrowed edge days). */
  totalInMonth: number;
  /** Loaded jobs that belong to another month — "trống ở đây" ≠ "không có gì". */
  totalOutsideMonth: number;
  /** Soonest loaded day outside this month, for a "đi tới tháng có bài" action. */
  nearestDayKeyOutsideMonth: string | null;
  skipped: SkippedCalendarJob[];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Day key of a local calendar position. `dayNumber` may overflow either end
 * (0 = last day of the previous month, 32 = spills into the next one) — that is
 * the whole point: the runtime normalises it on the calendar, not on a
 * fixed-length millisecond ruler.
 */
function dayKeyAt(year: number, monthIndex: number, dayNumber: number): string {
  const date = new Date(year, monthIndex, dayNumber);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Monday = 0 … Sunday = 6. `Date#getDay` counts from Sunday, so rotate it. */
function mondayFirstIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** "2026-08-13" -> "2026-08". `null` for anything that is not a real day. */
export function monthKeyOfDayKey(dayKey: unknown): string | null {
  return isDateOnly(dayKey) ? dayKey.slice(0, 7) : null;
}

/** Month the browser clock is in. `null` while the clock is still unknown (0). */
export function monthKeyOfMs(nowMs: number): string | null {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** Today's day key, or "" while the browser clock is unknown (server render). */
export function todayKeyOfMs(nowMs: number): string {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return "";
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Walks the month counter, not the day counter: "2026-01" minus one month is
 * "2025-12", and December plus one is next January. Junk in returns junk out
 * unchanged rather than producing a plausible-looking wrong month.
 */
export function shiftMonthKey(monthKey: string, delta: number): string {
  if (!isMonthKey(monthKey) || !Number.isInteger(delta)) return monthKey;
  const [year, month] = monthKey.split("-").map(Number);
  const total = year * 12 + (month - 1) + delta;
  return `${Math.floor(total / 12)}-${pad2((((total % 12) + 12) % 12) + 1)}`;
}

/**
 * Walks the day counter on the CALENDAR. Used by keyboard navigation that runs
 * off the edge of the grid, so an arrow key crossing a month boundary lands on
 * the real neighbouring day — and still does on the day a zone shifts.
 */
export function shiftDayKey(dayKey: string, delta: number): string {
  if (!isDateOnly(dayKey) || !Number.isInteger(delta)) return dayKey;
  const [year, month, day] = dayKey.split("-").map(Number);
  return dayKeyAt(year, month - 1, day + delta);
}

/**
 * The day an arrow key lands on when it runs off the edge of the grid.
 *
 * The two edge callbacks of `useGridFocus` do NOT mean the same thing, and that
 * is the whole reason this function exists (see the ArrowUp/Down/Left/Right
 * cases in `@astryxdesign/core/dist/hooks/useGridFocus.js`):
 *
 *   ArrowUp    onNavigateBefore(currentCol, columns)         offset 7, VERTICAL
 *   ArrowDown  onNavigateAfter(currentCol, columns)          offset 7, VERTICAL
 *   ArrowLeft  onNavigateBefore(wrapped dest col, 1)         offset 1, HORIZONTAL
 *   ArrowRight onNavigateAfter(wrapped dest col, 1)          offset 1, HORIZONTAL
 *
 * A vertical move keeps the caret in ITS OWN column, so the destination is the
 * cell one row outside the grid in that column. Treating it like a horizontal
 * move ("first/last cell of the grid ± offset") is only correct in the Thứ Hai
 * column going up and the Chủ Nhật column going down, and lands on a silently
 * wrong day everywhere else.
 *
 * A horizontal move needs no column at all: stepping one day off the corner
 * already lands in the column the hook reports.
 *
 * `null` means "do nothing" — a contract we do not recognise must not turn into
 * a plausible-looking wrong day.
 */
export function edgeNavigationDayKey(
  monthKey: string,
  direction: "before" | "after",
  column: number,
  offset: number,
): string | null {
  const weeks = buildMonthMatrix(monthKey);
  if (weeks.length === 0) return null;

  const step = direction === "before" ? -offset : offset;

  if (offset === CALENDAR_COLUMNS) {
    if (!Number.isInteger(column) || column < 0 || column >= CALENDAR_COLUMNS) return null;
    const row = direction === "before" ? weeks[0] : weeks[weeks.length - 1];
    const anchor = row?.[column];
    return anchor ? shiftDayKey(anchor, step) : null;
  }

  if (offset === 1) {
    const lastWeek = weeks[weeks.length - 1];
    const anchor =
      direction === "before" ? weeks[0]?.[0] : lastWeek?.[CALENDAR_COLUMNS - 1];
    return anchor ? shiftDayKey(anchor, step) : null;
  }

  // The hook only ever passes 1 or `columns`. Anything else means the vendor
  // contract moved; guessing a day would be worse than not moving.
  return null;
}

/**
 * The same day number inside another month, clamped to that month's last day —
 * PageUp from 31/08 lands on 31/07, but from 31/03 it lands on 28/02 rather
 * than silently rolling into March.
 */
export function sameDayInMonth(dayKey: string, monthKey: string): string | null {
  if (!isDateOnly(dayKey) || !isMonthKey(monthKey)) return null;
  const [year, month] = monthKey.split("-").map(Number);
  // Day 0 of the following month IS the last day of this one.
  const lastDay = new Date(year, month, 0).getDate();
  const wanted = Number(dayKey.slice(8, 10));
  return dayKeyAt(year, month - 1, Math.min(wanted, lastDay));
}

/**
 * Which month the grid is anchored to: the URL wins, then the open day (a
 * shared `?ngay=` link must land on the month that contains it), then the
 * browser clock. `null` only while that clock is still unknown — the caller
 * shows the skeleton rather than guessing a month the operator would then see
 * jump under them.
 */
export function resolveMonthKey(
  month: string | null,
  day: string | null,
  nowMs: number,
): string | null {
  if (isMonthKey(month)) return month;
  return monthKeyOfDayKey(day) ?? monthKeyOfMs(nowMs);
}

/** "Tháng 8 năm 2026". Built from the string — no `Date`, so no zone to get wrong. */
export function formatMonthHeading(monthKey: string): string {
  if (!isMonthKey(monthKey)) return monthKey;
  const [year, month] = monthKey.split("-");
  return `Tháng ${Number(month)} năm ${year}`;
}

/**
 * The 6×7 day keys of a month, Monday first. Always six rows so the grid keeps
 * one height all year. Returns `[]` for a monthKey that is not a month — the
 * screen then has a state to render instead of a crash.
 */
export function buildMonthMatrix(monthKey: string): string[][] {
  if (!isMonthKey(monthKey)) return [];

  const [year, month] = monthKey.split("-").map(Number);
  const monthIndex = month - 1;
  const leading = mondayFirstIndex(new Date(year, monthIndex, 1));

  const weeks: string[][] = [];
  for (let row = 0; row < CALENDAR_ROWS; row += 1) {
    const days: string[] = [];
    for (let column = 0; column < CALENDAR_COLUMNS; column += 1) {
      // Day 1 sits at `leading`; every other cell is that offset away from it.
      days.push(dayKeyAt(year, monthIndex, row * CALENDAR_COLUMNS + column + 1 - leading));
    }
    weeks.push(days);
  }
  return weeks;
}

export interface GroupedCalendarJobs {
  byDay: Map<string, ScheduledJobEntry[]>;
  skipped: SkippedCalendarJob[];
}

/**
 * Buckets the loaded page by local day, preserving the soonest-first order the
 * server sent inside each bucket.
 *
 * A row whose `scheduledAt` is missing or unparsable is NOT dropped in silence
 * (business rule 5): it goes to `skipped` with a reason the screen can show, so
 * a broken row is visible as a broken row instead of a post that vanished.
 */
export function groupJobsByDay(items: readonly ScheduledJobEntry[]): GroupedCalendarJobs {
  const byDay = new Map<string, ScheduledJobEntry[]>();
  const skipped: SkippedCalendarJob[] = [];

  if (!Array.isArray(items)) return { byDay, skipped };

  for (const item of items) {
    if (!item || typeof item.scheduledAt !== "string" || item.scheduledAt.trim().length === 0) {
      skipped.push({
        postJobId: item?.postJobId ?? "(không rõ mã bài)",
        reason: "Bài này không có giờ hẹn nên không xếp được vào lịch.",
      });
      continue;
    }

    const dayKey = localDayKey(item.scheduledAt);
    if (dayKey.length === 0) {
      skipped.push({
        postJobId: item.postJobId,
        reason: "Giờ hẹn của bài này không đọc được nên không xếp được vào lịch.",
      });
      continue;
    }

    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(item);
    else byDay.set(dayKey, [item]);
  }

  return { byDay, skipped };
}

export interface BuildCalendarMonthParams {
  monthKey: string;
  items: readonly ScheduledJobEntry[];
  /** 0 while the browser clock is unknown: nothing is then "hôm nay" or "quá khứ". */
  nowMs: number;
  maxVisiblePerDay?: number;
}

/**
 * One pass over the loaded jobs, one pass over the 42 cells (web-calendar-view
 * rule 4: no nested loop over events per cell — that is how a dense calendar
 * starts dropping frames).
 */
export function buildCalendarMonth({
  monthKey,
  items,
  nowMs,
  maxVisiblePerDay = CALENDAR_MAX_VISIBLE_PER_DAY,
}: BuildCalendarMonthParams): CalendarMonth {
  const matrix = buildMonthMatrix(monthKey);
  const { byDay, skipped } = groupJobsByDay(items);
  const today = todayKeyOfMs(nowMs);
  const limit = Number.isInteger(maxVisiblePerDay) && maxVisiblePerDay > 0 ? maxVisiblePerDay : 1;

  let totalInMonth = 0;
  let totalOutsideMonth = 0;
  let nearestDayKeyOutsideMonth: string | null = null;

  // Counted from the JOBS, not from the cells: a job on a borrowed edge day of
  // the neighbouring month belongs to that month, not to this one.
  for (const [dayKey, bucket] of byDay) {
    if (dayKey.slice(0, 7) === monthKey) continue;
    totalOutsideMonth += bucket.length;
    if (nearestDayKeyOutsideMonth === null || dayKey < nearestDayKeyOutsideMonth) {
      nearestDayKeyOutsideMonth = dayKey;
    }
  }

  const weeks: CalendarWeek[] = matrix.map((row) => ({
    key: row[0],
    days: row.map((dayKey) => {
      const jobs = byDay.get(dayKey) ?? [];
      const inMonth = dayKey.slice(0, 7) === monthKey;
      if (inMonth) totalInMonth += jobs.length;

      return {
        dayKey,
        dayOfMonth: Number(dayKey.slice(8, 10)),
        inMonth,
        // ISO day keys compare correctly as plain strings — no Date needed.
        isToday: today.length > 0 && dayKey === today,
        isPast: today.length > 0 && dayKey < today,
        jobs,
        visibleJobs: jobs.slice(0, limit),
        overflowCount: Math.max(0, jobs.length - limit),
      };
    }),
  }));

  return {
    monthKey,
    weeks,
    totalInMonth,
    totalOutsideMonth,
    nearestDayKeyOutsideMonth,
    skipped,
  };
}
