/**
 * Folding the two /posts tables (spec §3.2 "gom dòng trùng mã đa kênh").
 *
 * A post_job is ONE bài × ONE kênh (business rule 6), so a single post sent to
 * five Pages arrives as five rows that differ only in the channel column. Read
 * down the table, those five rows are one thing that happened — and five copies
 * of the same product code, the same colour and the same failure sentence is
 * exactly what makes a job log unreadable at 30 mã/sáng.
 *
 * THE INVARIANT: rows fold only when every value the FOLDED row still shows is
 * identical. The key is therefore built from the displayed fields, not from the
 * ids — which is why two jobs of one code that failed for different reasons stay
 * two rows (they are two stories), while five identical failures become
 * "MGKVX6310 × 5 kênh" with the channels one click away.
 *
 * Two fields are deliberately OUT of both keys because they are per-job by
 * design and the caller says so on the row instead:
 *  - `updatedAt` / `scheduledAt` — the publish spacing (E5) staggers a fan-out
 *    by minutes, so folding on the exact instant would fold nothing at all. The
 *    row shows the head's value and marks it "mới nhất" / "sớm nhất".
 *  - the published permalink — one per channel. The folded row hides it and the
 *    expanded panel gives every channel its own link.
 *
 * Pure and node-testable: no React, no DOM, no I/O.
 */

/** The minimum a row needs to be folded: which channel it went to. */
export interface FoldableJob {
  readonly channelId: string;
}

export interface JobRowGroup<T> {
  /** Stable across renders and unique on the list — usable as a React key. */
  readonly key: string;
  /** The first row of the group in source order; what the folded row shows. */
  readonly head: T;
  /** Every row of the group, head first, in source order. Never empty. */
  readonly members: readonly T[];
  /** How many JOBS folded here. */
  readonly count: number;
  /** How many DISTINCT channels those jobs went to — what the label counts. */
  readonly channelCount: number;
}

/**
 * Separator that cannot appear in a code, a colour or a message — the same NUL
 * `overview-model` folds with. A printable one would let "AB" + "CD" collide
 * with "ABCD" + "".
 */
const UNIT = "\u0000";

/**
 * Folds `items` by `foldKey`, keeping every group at the position of its first
 * row so the list's own order (newest first / soonest first) survives.
 *
 * `foldKey` returning `null` means "this row never folds" — used when a row
 * cannot even be named (no product code), where a fold would produce a summary
 * line nobody could read.
 *
 * Defensive on the way in: a failed query hands `undefined` around often enough
 * that crashing here would blank a table that has a perfectly good error state.
 */
export function groupJobRows<T extends FoldableJob>(
  items: readonly T[],
  foldKey: (item: T) => string | null,
): JobRowGroup<T>[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const order: string[] = [];
  const byKey = new Map<string, { head: T; members: T[]; channels: Set<string> }>();

  for (const [index, item] of items.entries()) {
    if (!item) continue;

    const folded = foldKey(item);
    // `null` = never fold. The index makes the key unique without making it
    // collide with a real fold key (which never contains the "#" prefix).
    const key = folded === null ? `#${index}` : folded;

    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(item);
      existing.channels.add(item.channelId);
      continue;
    }

    order.push(key);
    byKey.set(key, { head: item, members: [item], channels: new Set([item.channelId]) });
  }

  return order.map((key) => {
    const group = byKey.get(key)!;
    return {
      key,
      head: group.head,
      members: group.members,
      count: group.members.length,
      channelCount: group.channels.size,
    };
  });
}

/**
 * What a folded row is called: "MGKVX6310 × 5 kênh".
 *
 * When one channel somehow carries two jobs of the same key, the count switches
 * to "bài" rather than claiming a channel that is not there — the number on
 * screen has to match what expanding the row shows (The Named Status Rule: a
 * summary that cannot be checked is decoration).
 */
export function foldRowLabel<T extends FoldableJob>(code: string, group: JobRowGroup<T>): string {
  const suffix = foldCountLabel(group);
  return suffix === null ? code : `${code} ${suffix}`;
}

/**
 * Just the "× 5 kênh" half, for the cell that already shows the code above it —
 * `null` when the row stands alone and there is nothing to say.
 */
export function foldCountLabel<T extends FoldableJob>(group: JobRowGroup<T>): string | null {
  if (group.count <= 1) return null;
  if (group.channelCount === group.count) return `× ${group.count} kênh`;
  return `× ${group.count} bài`;
}

/** True when every member of the group agrees on `pick` — head included. */
export function isFoldUniform<T, V>(group: JobRowGroup<T>, pick: (item: T) => V): boolean {
  const first = pick(group.head);
  return group.members.every((member) => pick(member) === first);
}

/**
 * The job log's key: everything the folded row keeps showing — the lot, the
 * code, the colour, the status, how many times it was tried, the error code,
 * the operator sentence, and whether "Chạy lại" is on offer.
 *
 * `attemptCount` is IN on purpose: a channel that took three tries and one that
 * took one did not have the same day, and the "Lần thử" column would have to
 * lie about one of them.
 */
export function jobLogFoldKey(job: {
  batchId: string;
  productCode: string;
  color: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  userMessage: string;
  canRetry: boolean;
}): string | null {
  const code = job.productCode.trim();
  if (code.length === 0) return null;

  return [
    "log",
    job.batchId,
    code,
    job.color.trim(),
    job.status,
    String(job.attemptCount),
    job.lastErrorCode ?? "",
    job.userMessage.trim(),
    job.canRetry ? "retry" : "no-retry",
  ].join(UNIT);
}

/**
 * The schedule's key. Same invariant, over the columns that table shows: the
 * hour is excluded (publish spacing staggers it) but `overdue`, the caption
 * preview, the photo count and both actions are in, because the folded row
 * still displays all four.
 */
export function scheduledFoldKey(job: {
  batchId: string;
  productCode: string;
  color: string;
  status: string;
  overdue: boolean;
  captionPreview: string;
  mediaCount: number;
  userMessage: string;
  canReschedule: boolean;
  canCancel: boolean;
}): string | null {
  const code = job.productCode.trim();
  if (code.length === 0) return null;

  return [
    "scheduled",
    job.batchId,
    code,
    job.color.trim(),
    job.status,
    job.overdue ? "overdue" : "on-time",
    job.captionPreview.trim(),
    String(job.mediaCount),
    job.userMessage.trim(),
    job.canReschedule ? "can-reschedule" : "locked",
    job.canCancel ? "can-cancel" : "no-cancel",
  ].join(UNIT);
}
