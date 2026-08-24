import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import {
  channelLabelIndex,
  channelNameOf,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
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
  /** The lot this job belongs to; lets a folded row link to its own filter. */
  readonly batchId?: string;
}

/** One job still waiting for its hour. */
export interface UpcomingJobInput {
  readonly id: string;
  readonly code: string;
  readonly color?: string;
  readonly channelName: string;
  /** ISO instant. Anything unparseable is kept, never guessed at. */
  readonly scheduledAt: string;
  readonly batchId?: string;
}

/**
 * What ONE row of the block stands for once identical jobs have been folded
 * together (see `pickAttentionItems`).
 *
 * A post goes out as one `post_job` PER CHANNEL, so one expired token produces
 * one row per Page: the block filled all six of its slots with the same code
 * and the same sentence, and every other broken code fell off the screen. The
 * row now names the fan-out instead of repeating it.
 */
export interface AttentionFold {
  /** Jobs behind this row. `1` means nothing was folded. */
  readonly jobCount: number;
  /** Their channels, source order, de-duplicated. Always ≥ 1 entry. */
  readonly channelNames: readonly string[];
  /**
   * Every folded job says the same thing — the same failure sentence, or the
   * same hour. False means the row may only show the count, never one member's
   * sentence as if it spoke for the others.
   */
  readonly isUniform: boolean;
  /** The lot they all belong to, or `null` when they do not agree on one. */
  readonly batchId: string | null;
}

export type AttentionItem =
  | ({ readonly kind: "failed" } & FailedJobInput & AttentionFold)
  | ({ readonly kind: "upcoming" } & UpcomingJobInput & AttentionFold);

/**
 * Six ROWS — folded rows, since the fold happens before the cut. The block is a
 * to-do list an operator reads standing up, not a second job log; the log
 * itself is one click away from every row.
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
 * The fold key: the same PRODUCT, in the same colour, on the same side of the
 * block. Deliberately NOT the reason — a code whose channels failed for two
 * different reasons is still one thing to go and look at, and the row says so
 * (`isUniform: false`) instead of splitting into two half-truths.
 */
function foldKey(kind: "failed" | "upcoming", job: { code: string; color?: string }): string {
  return `${kind}\u0000${job.code.trim()}\u0000${(job.color ?? "").trim()}`;
}

/** Accumulator for one folded row: the head job plus what the rest add to it. */
interface Fold<T> {
  head: T;
  jobCount: number;
  channelNames: string[];
  isUniform: boolean;
  /** `undefined` = no member named a lot yet; `null` = they disagree. */
  batchId: string | null | undefined;
}

function startFold<T extends { channelName?: string; batchId?: string }>(head: T): Fold<T> {
  const name = trimmed(head.channelName);
  const batchId = trimmed(head.batchId);
  return {
    head,
    jobCount: 1,
    channelNames: name.length > 0 ? [name] : [],
    isUniform: true,
    batchId: batchId.length > 0 ? batchId : null,
  };
}

/** Adds one more job to a row that already exists. `sameStory` is the caller's. */
function extendFold<T extends { channelName?: string; batchId?: string }>(
  fold: Fold<T>,
  job: T,
  sameStory: boolean,
): void {
  fold.jobCount += 1;
  if (!sameStory) fold.isUniform = false;

  const name = trimmed(job.channelName);
  if (name.length > 0 && !fold.channelNames.includes(name)) fold.channelNames.push(name);

  const batchId = trimmed(job.batchId);
  if (fold.batchId !== null && fold.batchId !== (batchId.length > 0 ? batchId : null)) {
    fold.batchId = null;
  }
}

function sealFold<T>(fold: Fold<T>): AttentionFold {
  return {
    jobCount: fold.jobCount,
    // Never empty: a row that named no channel still has to say something, and
    // "—" is what `channelLabel` already produces for an unnameable id.
    channelNames: fold.channelNames.length > 0 ? fold.channelNames : ["—"],
    isUniform: fold.isUniform,
    batchId: fold.batchId ?? null,
  };
}

/**
 * What the operator has to look at, in the order they have to look at it.
 *
 * Failed first, always: a post that did not go out is a problem that is already
 * costing something, while "sắp tới giờ" is only a heads-up. Within each side
 * the source order is kept — the job log arrives newest-first, and the schedule
 * is re-sorted here so the soonest hour is on top even if a caller hands the
 * rows over unsorted.
 *
 * Jobs of the same code and colour FOLD into one row before the six-row cut is
 * applied, so one broken token cannot push every other broken code off the
 * screen (see `AttentionFold`). The head of each row is its first job, which is
 * also the one whose hour is shown — the upcoming side is sorted first, so that
 * is the soonest of the group.
 */
export function pickAttentionItems(input: {
  failedJobs: readonly FailedJobInput[];
  upcoming: readonly UpcomingJobInput[];
}): AttentionItem[] {
  const failedJobs = Array.isArray(input?.failedJobs) ? input.failedJobs : [];
  const upcoming = Array.isArray(input?.upcoming) ? input.upcoming : [];

  const seen = new Set<string>();
  const order: string[] = [];
  const folds = new Map<string, Fold<FailedJobInput | UpcomingJobInput>>();
  const kinds = new Map<string, "failed" | "upcoming">();

  /**
   * The row cut counts ROWS, so it is checked only when a NEW row would open.
   * A job that belongs to a row already on the list keeps being folded into it
   * even after the sixth row exists — otherwise "× 5 kênh" would quietly become
   * "× 2 kênh" as soon as the block filled up, which is the same lie the fold
   * was written to remove.
   */
  function take(
    kind: "failed" | "upcoming",
    job: FailedJobInput | UpcomingJobInput,
    sameStory: (head: FailedJobInput | UpcomingJobInput) => boolean,
  ): void {
    const key = foldKey(kind, job);
    const existing = folds.get(key);
    if (existing) {
      seen.add(job.id);
      extendFold(existing, job, sameStory(existing.head));
      return;
    }
    if (order.length >= ATTENTION_LIMIT) return;
    seen.add(job.id);
    order.push(key);
    kinds.set(key, kind);
    folds.set(key, startFold(job));
  }

  for (const job of failedJobs) {
    if (!job || !isUsable(job) || seen.has(job.id)) continue;
    take("failed", job, (head) => (head as FailedJobInput).reason === job.reason);
  }

  const sorted = [...upcoming]
    .filter((job) => job && isUsable(job) && !seen.has(job.id))
    .sort((a, b) => instantOrder(a.scheduledAt) - instantOrder(b.scheduledAt));

  for (const job of sorted) {
    if (seen.has(job.id)) continue;
    take("upcoming", job, (head) => (head as UpcomingJobInput).scheduledAt === job.scheduledAt);
  }

  return order.map((key) => {
    const fold = folds.get(key)!;
    // `...head` before the fold fields, and never a bare `color: undefined`:
    // an upcoming row without a colour must not grow the key.
    return { kind: kinds.get(key)!, ...fold.head, ...sealFold(fold) } as AttentionItem;
  });
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

/**
 * The number on a stat tile that has a REAL total behind it.
 *
 * The catalog endpoint aggregates its totals in SQL over the whole tenant
 * (`aggregateCatalog`), not over the page it happens to return, so the blocked
 * count is exact and printing "12+" would understate a number we actually know.
 * The loading/unavailable arms are the same as `statValue` for the same reason:
 * an absent page must never be read as a confident zero.
 */
export function statTotal(input: {
  /** At least one page of the query has arrived. */
  hasData: boolean;
  isError: boolean;
  /** `undefined` = the page arrived without the field (never, if zod held). */
  total: number | undefined;
}): StatValue {
  if (input?.hasData !== true) {
    return input?.isError === true ? { kind: "unavailable" } : { kind: "loading" };
  }
  if (typeof input.total !== "number" || !Number.isFinite(input.total) || input.total < 0) {
    return { kind: "unavailable" };
  }
  return { kind: "count", text: formatLoadedCount({ loaded: input.total, hasNextPage: false }) };
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

/** The id the way the label index keys it: trimmed, blank when there is none. */
function normalizeChannelId(channelId: string): string {
  return typeof channelId === "string" ? channelId.trim() : "";
}

/**
 * ONE index for a whole list of rows — built before the map, never inside it.
 *
 * `channelNameOf` rebuilds a Map of every channel on each call, so naming rows
 * one at a time is O(rows × channels) — exactly what `channelLabelIndex` exists
 * to stop, and what its docblock asks callers not to do. Blank ids never reach
 * the index: `channelLabelFrom` answers "—" for them without a lookup.
 */
export function channelLabelIndexFor(
  channelIds: readonly string[],
  channels: readonly Channel[] | undefined,
): ReadonlyMap<string, GroupChannelLabel> {
  return channelLabelIndex(
    channelIds.map(normalizeChannelId).filter((id) => id.length > 0),
    channels,
  );
}

/**
 * The Page name for a channel id, the way every other screen says it.
 *
 * Delegates to the shared rule (spec §3.1) instead of keeping a second, softer
 * one: this screen used to print a bare id for a Page that had been removed,
 * so the attention list quietly named something an operator could not look up.
 * Now it says "…(đã gỡ)" / "…(đang tắt)" like the log, the schedule and /bulk.
 *
 * The one thing it keeps for itself: an EMPTY id becomes "—", because a
 * dashboard row still has to render a cell.
 */
export function channelLabelFrom(
  channelId: string,
  index: ReadonlyMap<string, GroupChannelLabel>,
): string {
  const id = normalizeChannelId(channelId);
  if (id.length === 0) return "—";
  return channelSentenceName(id, index);
}

/**
 * `channelLabelFrom` for a caller holding ONE id and no index — a single cell,
 * never a list. A list resolves once with `channelLabelIndexFor` first.
 */
export function channelLabel(
  channelId: string,
  channels: readonly Channel[] | undefined,
): string {
  const id = normalizeChannelId(channelId);
  if (id.length === 0) return "—";
  return channelNameOf(id, channels);
}
