import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * The rules behind the overview, kept out of the component so they can be
 * tested without rendering (docs/07 §4.1: a component decides nothing on its
 * own that a pure function could decide).
 *
 * Everything here is defensive on purpose: both lists arrive from a cursor
 * query that may be mid-flight, empty, or partially loaded, and this screen is
 * the first thing an operator sees in the morning — it must not be able to
 * crash, and it must never state a number it cannot vouch for.
 */

/** One failed job, reduced to what the attention list needs. */
export interface FailedJobInput {
  readonly id: string;
  readonly code: string;
  /** Normalised colour of the post, when the row has one — never required. */
  readonly color?: string;
  readonly channelName: string;
  readonly reason: string;
}

/** One job still waiting for its hour. */
export interface UpcomingJobInput {
  readonly id: string;
  readonly code: string;
  readonly color?: string;
  readonly channelName: string;
  /** ISO instant. Anything unparseable is kept, never guessed at. */
  readonly scheduledAt: string;
}

export type AttentionItem =
  | ({ readonly kind: "failed" } & FailedJobInput)
  | ({ readonly kind: "upcoming" } & UpcomingJobInput);

/**
 * Six rows. The block is a to-do list an operator reads standing up, not a
 * second job log — the log itself is one click away from every row.
 */
export const ATTENTION_LIMIT = 6;

function isUsable(entry: { id?: unknown; code?: unknown }): boolean {
  return (
    typeof entry.id === "string" &&
    entry.id.trim().length > 0 &&
    typeof entry.code === "string" &&
    entry.code.trim().length > 0
  );
}

/** Sortable key: an unreadable hour goes last instead of to 1970. */
function instantOrder(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/**
 * What the operator has to look at, in the order they have to look at it.
 *
 * Failed first, always: a post that did not go out is a problem that is already
 * costing something, while "sắp tới giờ" is only a heads-up. Within each side
 * the source order is kept — the job log arrives newest-first, and the schedule
 * is re-sorted here so the soonest hour is on top even if a caller hands the
 * rows over unsorted.
 */
export function pickAttentionItems(input: {
  failedJobs: readonly FailedJobInput[];
  upcoming: readonly UpcomingJobInput[];
}): AttentionItem[] {
  const failedJobs = Array.isArray(input?.failedJobs) ? input.failedJobs : [];
  const upcoming = Array.isArray(input?.upcoming) ? input.upcoming : [];

  const seen = new Set<string>();
  const items: AttentionItem[] = [];

  for (const job of failedJobs) {
    if (items.length >= ATTENTION_LIMIT) return items;
    if (!job || !isUsable(job) || seen.has(job.id)) continue;
    seen.add(job.id);
    items.push({ kind: "failed", ...job });
  }

  const sorted = [...upcoming]
    .filter((job) => job && isUsable(job) && !seen.has(job.id))
    .sort((a, b) => instantOrder(a.scheduledAt) - instantOrder(b.scheduledAt));

  for (const job of sorted) {
    if (items.length >= ATTENTION_LIMIT) break;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    items.push({ kind: "upcoming", ...job });
  }

  return items;
}

/**
 * The number on a stat tile, from ONE cursor page.
 *
 * There is no total in either response (E8.4 / E11.1 both paginate by cursor),
 * so a page that still has a `nextCursor` is reported as "25+" — the honest
 * shape of "at least this many". Inventing a total here would put a wrong
 * number on the first screen of the day.
 */
export function formatLoadedCount(input: { loaded: number; hasNextPage: boolean }): string {
  const loaded = input?.loaded;
  if (typeof loaded !== "number" || !Number.isFinite(loaded) || loaded < 0) return "—";

  const exact = Math.floor(loaded).toLocaleString("vi-VN");
  return input.hasNextPage ? `${exact}+` : exact;
}

/** Why a job failed, in one line, without ever printing an empty cell. */
export function failureReason(job: {
  userMessage: string | null;
  lastErrorCode: string | null;
}): string {
  const message = typeof job?.userMessage === "string" ? job.userMessage.trim() : "";
  if (message.length > 0) return message;

  const code = typeof job?.lastErrorCode === "string" ? job.lastErrorCode.trim() : "";
  if (code.length > 0) return `Mã lỗi ${code}`;

  return "Không rõ lý do — mở nhật ký để xem chi tiết.";
}

/**
 * The Page name for a channel id, or the id itself.
 *
 * `channels === undefined` means the list is not known yet (loading, or the
 * request failed): the row then shows the raw id, which is ugly but true. Same
 * rule as `resolveGroupChannelLabels` — this screen only needs the name, never
 * the "đã gỡ" verdict, so it does not repeat that logic.
 */
export function channelLabel(
  channelId: string,
  channels: readonly Channel[] | undefined,
): string {
  const id = typeof channelId === "string" ? channelId.trim() : "";
  if (id.length === 0) return "—";
  if (channels === undefined) return id;

  const found = channels.find((channel) => channel.channelId === id);
  const name = found?.name.trim() ?? "";
  return name.length > 0 ? name : id;
}
