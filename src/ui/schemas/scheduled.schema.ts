import { z } from "zod";

import { PostFormatSchema, PostJobStatusSchema } from "./post-batch.schema";

/**
 * Contracts of "Bài đã hẹn" (E8.4) and of the "hẹn giờ đăng" control (E8.1 UI).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so this
 * MIRRORS `core/usecases/list-scheduled-jobs`, `reschedule-post-job`,
 * `cancel-scheduled-job` and the schedule window of `core/domain/post-job`
 * (MAX_SCHEDULE_AHEAD_MS = 30 days, MIN_SCHEDULE_AHEAD_MS = 1s). The runtime
 * parse in `http-client` is what makes a drift loud instead of silent.
 *
 * Three kinds of time value live here and are NEVER mixed (core-form-inputs):
 *  - an INSTANT: `scheduledAt`, always an ISO string on the wire, rendered in
 *    the operator's own zone (booking rule 1: never a bare hour);
 *  - a PURE DATE: the `from`/`to` filter, kept as "YYYY-MM-DD" strings in the
 *    URL and only turned into instants when a request is built;
 *  - a LOCAL WALL TIME: the `datetime-local` field, "YYYY-MM-DDTHH:mm", which
 *    the browser interprets in the operator's zone.
 */

// --- The schedule window (mirror of core/domain/post-job) --------------------

export const MAX_SCHEDULE_AHEAD_DAYS = 30;
export const MAX_SCHEDULE_AHEAD_MS = MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000;
/** Below this "hẹn giờ" is really "đăng ngay" — the server refuses it. */
export const MIN_SCHEDULE_AHEAD_MS = 1_000;

// --- GET /api/posts/scheduled -----------------------------------------------

export const ScheduledJobEntrySchema = z.object({
  postJobId: z.string().min(1),
  batchId: z.string().min(1),
  productCode: z.string().min(1),
  color: z.string(),
  channelId: z.string().min(1),
  format: PostFormatSchema,
  status: PostJobStatusSchema,
  scheduledAt: z.iso.datetime(),
  /** Server-side countdown at read time; negative when the hour already passed. */
  startsInMs: z.number(),
  overdue: z.boolean(),
  captionPreview: z.string(),
  mediaCount: z.number(),
  userMessage: z.string(),
  /** Decided by the SERVER. The UI never derives it from the status itself. */
  canReschedule: z.boolean(),
  canCancel: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ScheduledJobEntry = z.infer<typeof ScheduledJobEntrySchema>;

export const ScheduledJobsResponseSchema = z.object({
  tenantId: z.string().min(1),
  items: z.array(ScheduledJobEntrySchema),
  /** Opaque; `null` means this was the last page. */
  nextCursor: z.string().nullable(),
  limit: z.number(),
});
export type ScheduledJobsResponse = z.infer<typeof ScheduledJobsResponseSchema>;

// --- Row actions ------------------------------------------------------------

/**
 * True while FACEBOOK holds the post, not our queue (E8.6). Everything the two
 * cases have in common ("chưa lên kênh") hides the one difference that decides
 * what an operator can still do, so the screens ask this explicitly.
 */
export function isHeldByPlatform(status: ScheduledJobEntry["status"]): boolean {
  return status === "scheduled_on_facebook";
}

/**
 * Why "Đổi giờ" is off for a row that can still be cancelled — `null` when the
 * button is available, or when the whole row is past its hour (the cell already
 * says so on its own).
 *
 * `canReschedule` is still the SERVER's decision; this only turns that "no" into
 * a sentence. Rule: hiện + vô hiệu hoá + nói rõ lý do (core-auth-session decision
 * tree) — a disabled control with no explanation is the anti-pattern, and so is
 * an enabled one that can only ever 409.
 */
export function rescheduleBlockedReason(
  job: Pick<ScheduledJobEntry, "status" | "canReschedule" | "canCancel">,
): string | null {
  if (job.canReschedule) return null;
  // Past its hour: no action at all is offered, and the cell explains that.
  if (!job.canCancel) return null;
  if (isHeldByPlatform(job.status)) {
    return "Bài đã giao cho Facebook giữ nên không đổi giờ trực tiếp được. Hãy bấm Huỷ — hệ thống sẽ gỡ bài khỏi Facebook — rồi soạn lại với giờ mới.";
  }
  return "Bài này không đổi giờ được nữa. Nếu không muốn bài lên, hãy bấm Huỷ.";
}

// --- POST /api/posts/scheduled/:id/reschedule -------------------------------

export const RescheduleJobResponseSchema = z.object({
  tenantId: z.string().min(1),
  postJobId: z.string().min(1),
  channelId: z.string().min(1),
  batchId: z.string().min(1),
  previousScheduledAt: z.iso.datetime().nullable(),
  scheduledAt: z.iso.datetime(),
  delayMs: z.number(),
  queueJobId: z.string().min(1),
  /**
   * False = the OLD delayed entry could not be dropped. The post may still fire
   * at the old hour, so the screen says it out loud instead of hiding it.
   */
  previousQueueEntryRemoved: z.boolean(),
  userMessage: z.string(),
});
export type RescheduleJobResponse = z.infer<typeof RescheduleJobResponseSchema>;

// --- POST /api/posts/scheduled/:id/cancel -----------------------------------

export const CancelScheduledJobResponseSchema = z.object({
  tenantId: z.string().min(1),
  postJobId: z.string().min(1),
  batchId: z.string().min(1),
  channelId: z.string().min(1),
  status: z.literal("blocked"),
  scheduledAt: z.iso.datetime().nullable(),
  queueEntryRemoved: z.boolean(),
  /**
   * E8.6 — true when this cancel deleted the post ON Facebook. A post Facebook
   * was holding owns no queue entry, so `queueEntryRemoved` comes back false for
   * it; without this flag the screen would raise a "lịch cũ còn trong hàng đợi"
   * warning about an entry that never existed.
   */
  platformPostDeleted: z.boolean(),
  userMessage: z.string(),
});
export type CancelScheduledJobResponse = z.infer<typeof CancelScheduledJobResponseSchema>;

/** Operator note attached to a cancellation (stored in the audit payload). */
export const MAX_CANCEL_NOTE_LENGTH = 500;

// --- Filter: the URL is the source of truth (core-data-list-query rule 1) ---

export const SCHEDULED_DEFAULT_LIMIT = 50;

/** Query params of the two row dialogs — a modal must have a URL, not useState. */
export const SCHEDULED_DIALOG_PARAMS = {
  reschedule: "doi-gio",
  cancel: "huy",
} as const;

export interface ScheduledFilter {
  /** `null` = every channel. */
  channelId: string | null;
  /** Pure dates, "YYYY-MM-DD". `from` is inclusive, `to` covers the whole day. */
  from: string | null;
  to: string | null;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) return false;
  // "2026-02-31" matches the pattern but is not a day.
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

/** Parses `?channelId=&from=&to=`; anything invalid falls back to "no filter". */
export function parseScheduledFilter(params: URLSearchParams): ScheduledFilter {
  const channelId = params.get("channelId")?.trim() ?? "";
  const from = params.get("from")?.trim() ?? "";
  const to = params.get("to")?.trim() ?? "";
  const validFrom = isDateOnly(from) ? from : null;
  const validTo = isDateOnly(to) ? to : null;

  // An inverted window returns nothing forever; drop the end instead of asking
  // the server for an empty set it will (rightly) refuse with a 400.
  const inverted = validFrom !== null && validTo !== null && validTo < validFrom;

  return {
    channelId: channelId.length > 0 ? channelId : null,
    from: validFrom,
    to: inverted ? null : validTo,
  };
}

/** THE single query-string builder. Defaults are omitted so a link stays clean. */
export function scheduledSearchParams(filter: ScheduledFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.channelId) params.set("channelId", filter.channelId);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  return params;
}

export function hasScheduledFilter(filter: ScheduledFilter): boolean {
  return filter.channelId !== null || filter.from !== null || filter.to !== null;
}

// --- Pure date <-> instant (only place that crosses the line) ---------------

/** Start of that local day as an instant, e.g. "2026-08-13" -> 00:00 local. */
export function dayStartIso(dateOnly: string): string | null {
  if (!isDateOnly(dateOnly)) return null;
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

/**
 * Exclusive upper bound covering the WHOLE selected day: the operator picking
 * "đến 13/08" means "kể cả 23:59 ngày 13/08", not "tới 00:00 ngày 13/08".
 */
export function dayEndIso(dateOnly: string): string | null {
  if (!isDateOnly(dateOnly)) return null;
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString();
}

// --- datetime-local <-> instant --------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local wall time for `<input type="datetime-local">` — never UTC. */
export function toDateTimeLocalValue(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `min`/`max` of the field: the window is shown BEFORE a choice is made. */
export function scheduleInputBounds(nowMs: number): { min: string; max: string } {
  return {
    // One minute ahead: the field has minute resolution, so "now" would round
    // into the past between render and submit.
    min: toDateTimeLocalValue(new Date(nowMs + 60_000)),
    max: toDateTimeLocalValue(new Date(nowMs + MAX_SCHEDULE_AHEAD_MS)),
  };
}

export type ScheduleInputResult =
  | { ok: true; at: Date; iso: string; delayMs: number }
  | { ok: false; message: string };

/**
 * Client-side copy of `evaluateScheduledAt` (core/domain/post-job). It exists to
 * fail fast in the browser with the same sentence the server would return — the
 * SERVER still decides: this only saves a round trip, it never grants anything.
 */
export function validateScheduleInput(value: string, nowMs: number): ScheduleInputResult {
  // --- Edge cases first ----------------------------------------------------
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) {
    return { ok: false, message: "Chưa chọn giờ đăng. Chọn ngày giờ hoặc chuyển về “Đăng ngay”." };
  }

  // `new Date("YYYY-MM-DDTHH:mm")` is parsed as LOCAL time by spec — exactly
  // what the operator typed. Never `Date.parse` a bare date here.
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, message: "Giờ hẹn đăng không hợp lệ." };
  }

  const delayMs = at.getTime() - nowMs;
  if (delayMs < MIN_SCHEDULE_AHEAD_MS) {
    return {
      ok: false,
      message: "Giờ hẹn đăng đã trôi qua — hãy chọn một thời điểm trong tương lai.",
    };
  }
  if (delayMs > MAX_SCHEDULE_AHEAD_MS) {
    return {
      ok: false,
      message: `Chỉ được hẹn đăng trong vòng ${MAX_SCHEDULE_AHEAD_DAYS} ngày.`,
    };
  }

  return { ok: true, at, iso: at.toISOString(), delayMs };
}

// --- Display ----------------------------------------------------------------

/** "13/08/2026 15:30" in the operator's own zone. */
export function formatScheduledAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** "15:30" — used inside a day group, where the date is in the heading. */
export function formatScheduledTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

/**
 * Zone label shown next to every hour (core-booking-scheduling rule 1: a bare
 * hour is the number-one cause of a missed schedule).
 */
export function timeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "giờ máy bạn";
  } catch {
    // A browser without a resolvable zone must still render an honest label
    // rather than crash the row it sits in.
    return "giờ máy bạn";
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "còn 2 giờ 5 phút" / "quá giờ 12 phút". Computed from an absolute deadline. */
export function formatCountdown(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) return "—";

  const overdue = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const prefix = overdue ? "quá giờ" : "còn";

  if (abs < MINUTE_MS) return overdue ? "quá giờ chưa tới 1 phút" : "còn dưới 1 phút";
  if (abs < HOUR_MS) return `${prefix} ${Math.floor(abs / MINUTE_MS)} phút`;
  if (abs < DAY_MS) {
    const hours = Math.floor(abs / HOUR_MS);
    const minutes = Math.floor((abs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${prefix} ${hours} giờ` : `${prefix} ${hours} giờ ${minutes} phút`;
  }
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${prefix} ${days} ngày` : `${prefix} ${days} ngày ${hours} giờ`;
}

/** Local day key of an instant, "YYYY-MM-DD" — the grouping key of the list. */
export function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Hôm nay · Thứ Năm, 13/08/2026" — the heading of one day group. */
export function formatDayHeading(dayKey: string, nowMs: number): string {
  if (!isDateOnly(dayKey)) return dayKey;
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const now = new Date(nowMs);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

  const full = new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);

  if (dayKey === todayKey) return `Hôm nay · ${full}`;
  if (dayKey === tomorrowKey) return `Ngày mai · ${full}`;
  return full;
}

export interface ScheduledDayGroup {
  dayKey: string;
  items: ScheduledJobEntry[];
}

/**
 * Groups the (already sorted, soonest first) page into day buckets. Order is
 * preserved — the list is a timeline, not a set.
 */
export function groupScheduledByDay(
  items: readonly ScheduledJobEntry[],
): ScheduledDayGroup[] {
  const groups: ScheduledDayGroup[] = [];
  for (const item of items) {
    const dayKey = localDayKey(item.scheduledAt);
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) last.items.push(item);
    else groups.push({ dayKey, items: [item] });
  }
  return groups;
}
