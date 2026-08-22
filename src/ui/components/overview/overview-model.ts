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

// --- "Lô đang chạy" ---------------------------------------------------------

/** One job row of the loaded log pages, reduced to what a lot needs. */
export interface RunningJobInput {
  readonly batchId: string;
  /** A `PostJobStatus` on the wire; typed wide so a new one cannot crash this. */
  readonly status: string;
  readonly code: string;
  /** ISO hour the job waits for, `null` when it is meant to go out now. */
  readonly scheduledAt?: string | null;
}

/** A batch with at least one job a worker is moving right now. */
export interface RunningBatch {
  readonly batchId: string;
  /** Running jobs of this lot among the pages loaded — never a server total. */
  readonly jobCount: number;
  /** The product code when every running job shares one, else `null`. */
  readonly code: string | null;
}

/** Cards on the overview. The batch screen behind each one owns the detail. */
export const RUNNING_BATCH_LIMIT = 4;

/**
 * Statuses that mean "a worker is going to move this on its own", mirroring
 * `ACTIVE_JOB_STATUSES` in `usePostJobs` — the same two the log polls for.
 */
const RUNNING_JOB_STATUSES: readonly string[] = ["queued", "publishing"];

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Is this row something an operator would call "đang chạy"?
 *
 * `queued` holds two very different populations (same trap as the worker-health
 * probe): a post meant to go out NOW, and a post parked until its hour. The
 * second one is already counted by the tape as "Đang chờ giờ", and calling it
 * running would claim movement where there is none — so a `queued` row with an
 * hour on it is not running. `publishing` means the worker holds it at this
 * moment, which an hour on the row does not change.
 */
function isRunning(job: RunningJobInput): boolean {
  const status = trimmed(job.status);
  if (!RUNNING_JOB_STATUSES.includes(status)) return false;
  if (status === "queued" && trimmed(job.scheduledAt).length > 0) return false;
  return true;
}

/**
 * The lots with work in flight, derived from the job pages the screen ALREADY
 * loaded — this adds no request of its own, so it can only ever describe rows
 * that are on the client. That is why `jobCount` is documented as "among the
 * pages loaded": the screen says "N+ lô" whenever a cursor page is outstanding
 * rather than pretending the number is a total (business rule 5).
 *
 * Source order is kept (the log arrives newest first), so the lot that started
 * most recently is the first card.
 */
export function pickRunningBatches(jobs: readonly RunningJobInput[]): RunningBatch[] {
  if (!Array.isArray(jobs)) return [];

  const order: string[] = [];
  const byBatch = new Map<string, { jobCount: number; code: string | null; mixed: boolean }>();

  for (const job of jobs) {
    if (!job || !isRunning(job)) continue;
    const batchId = trimmed(job.batchId);
    if (batchId.length === 0) continue;

    const code = trimmed(job.code);
    const lot = byBatch.get(batchId);
    if (!lot) {
      order.push(batchId);
      byBatch.set(batchId, { jobCount: 1, code: code.length > 0 ? code : null, mixed: false });
      continue;
    }
    lot.jobCount += 1;
    // Two codes in one lot, or a row that cannot name itself: the card then
    // shows the lot without a name instead of picking one of them.
    if (lot.code === null || lot.code !== code) lot.mixed = true;
  }

  return order.map((batchId) => {
    const lot = byBatch.get(batchId)!;
    return { batchId, jobCount: lot.jobCount, code: lot.mixed ? null : lot.code };
  });
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

/**
 * What one cell of the stat tape is allowed to say, given the state of the
 * query behind it.
 *
 * THE REGRESSION THIS EXISTS FOR — "số 0 giả": every count on this screen is
 * `items.length` over the pages a cursor query has loaded, and an empty array is
 * what that expression returns while the query is still in flight AND after it
 * has failed. Read straight, the first screen of the day opens on a confident
 * "0 bài lỗi" for a list nobody managed to read. The cell may only print a
 * number when a page actually arrived, and this function is the only place that
 * decides so.
 *
 * A query that has data AND an error is a REFRESH that failed: the number
 * stands (it is the last one we really read) and the error notice next to the
 * tape says the rest.
 */
export type StatValue =
  | { readonly kind: "loading" }
  /** No page has ever arrived and the query is not going to give one. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "count"; readonly text: string };

export function statValue(input: {
  /** At least one page of the cursor query has arrived. */
  hasData: boolean;
  isError: boolean;
  loaded: number;
  hasNextPage: boolean;
}): StatValue {
  if (input?.hasData !== true) {
    return input?.isError === true ? { kind: "unavailable" } : { kind: "loading" };
  }
  return {
    kind: "count",
    text: formatLoadedCount({ loaded: input.loaded, hasNextPage: input.hasNextPage === true }),
  };
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
