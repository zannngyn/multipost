/**
 * E7.5 — the vocabulary of "where is this post right now".
 *
 * Pure TypeScript, no imports outside core/domain (docs/07 §2).
 *
 * TWO LAWS ARE ENCODED HERE, not in the screen that draws them:
 *
 * 1. Progress is DECORATION, `post_job.status` is the truth (design §3.1). It
 *    may be missing, stale or lost; nothing in the publish flow may depend on
 *    it. That is why every function below is total: a constructor that throws
 *    would let a decoration kill a post.
 *
 * 2. Nobody invents a time remaining (design §3.2). Only the three WAITING
 *    stages can carry `waitUntil`, and `waitingProgress` is the only way to
 *    build one — `workingProgress` cannot accept the field at all, so the
 *    "3 photos took 2s each, so 7 more will take 14s" estimate that a 9 MB
 *    photo turns into a lie is impossible to add later without changing this
 *    signature in front of a reviewer.
 */

/** Ordered by when they happen; the array order is not a step index (see below). */
export const POST_JOB_STAGES = [
  /** queued, no worker has picked the job up yet. */
  "waiting_in_queue",
  /** Spacing gate — the wait length is KNOWN (publish-post §2). */
  "waiting_for_spacing",
  /** Scheduled, still outside the handoff window (publish-post §1c). */
  "waiting_for_schedule",
  /** Business rule 3 — the second stock check, right before the API call. */
  "checking_stock",
  /** Reading the channel credentials from tenant_integration. */
  "reading_channel",
  /** Video/reels only (E5.3). */
  "checking_video_spec",
  /** The only stage with a real done/total. */
  "uploading_media",
  /** The creating request is about to leave the process. */
  "sending_to_channel",
  /** E8.6 — handing the post to Facebook's own scheduler. */
  "handing_to_facebook",
  /** E8.6 — Facebook holds the post; the wait ends at the scheduled hour. */
  "waiting_on_facebook",
  "done",
  /** blocked | failed — the job stopped, whatever the reason. */
  "stopped",
] as const;

export type PostJobStage = (typeof POST_JOB_STAGES)[number];

/** The three stages whose remaining time the system actually computed. */
export const POST_JOB_WAITING_STAGES = [
  "waiting_for_spacing",
  "waiting_for_schedule",
  "waiting_on_facebook",
] as const;

export type PostJobWaitingStage = (typeof POST_JOB_WAITING_STAGES)[number];
export type PostJobWorkingStage = Exclude<PostJobStage, PostJobWaitingStage>;

const STAGE_SET: ReadonlySet<string> = new Set(POST_JOB_STAGES);
const WAITING_SET: ReadonlySet<string> = new Set(POST_JOB_WAITING_STAGES);

export function isPostJobStage(value: unknown): value is PostJobStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

export function isPostJobWaitingStage(value: unknown): value is PostJobWaitingStage {
  return typeof value === "string" && WAITING_SET.has(value);
}

export interface PostJobProgress {
  readonly stage: PostJobStage;
  /** Publish attempt this progress belongs to. Never negative (see below). */
  readonly attempt: number;
  /** Only `uploading_media` counts anything; null everywhere else. */
  readonly doneCount: number | null;
  readonly totalCount: number | null;
  /** File being handled, so the operator can see WHERE it stands. */
  readonly currentItem: string | null;
  readonly stageStartedAt: Date;
  /** ONLY when the system computed a real deadline (§3.2). Null otherwise. */
  readonly waitUntil: Date | null;
  readonly updatedAt: Date;
}

/**
 * A file name is shown to a human, not parsed. Long names are cut so one bad
 * row cannot push a multi-kilobyte string into Redis on every photo.
 */
const MAX_CURRENT_ITEM_LENGTH = 200;

export interface WaitingProgressInput {
  readonly attempt: number;
  /** A deadline the system COMPUTED. Never an estimate (§3.2). */
  readonly waitUntil: Date;
  readonly now: Date;
}

export interface WorkingProgressInput {
  readonly attempt: number;
  readonly now: Date;
  /** Only meaningful for `uploading_media`; ignored elsewhere. */
  readonly doneCount?: number;
  readonly totalCount?: number;
  readonly currentItem?: string;
}

/**
 * A stage that WAITS for a known instant. The deadline is mandatory: a wait we
 * cannot put a clock on is not one of these stages.
 *
 * A `waitUntil` already in the past is kept as it is, deliberately: it is still
 * what the system computed, and the honest reading is "the wait is over, the
 * next step has not started yet". Rewriting it to `now` would hide a worker
 * that stalled after the deadline.
 */
export function waitingProgress(
  stage: PostJobWaitingStage,
  input: WaitingProgressInput,
): PostJobProgress {
  const now = safeDate(input?.now);
  return {
    stage: isPostJobWaitingStage(stage) ? stage : "waiting_in_queue",
    attempt: safeAttempt(input?.attempt),
    doneCount: null,
    totalCount: null,
    currentItem: null,
    stageStartedAt: now,
    // An unusable date is dropped rather than faked: null means "no countdown",
    // which the screen can show honestly. Reaching this line means a caller bug,
    // and the missing countdown is what makes it visible.
    waitUntil: isUsableDate(input?.waitUntil) ? input.waitUntil : null,
    updatedAt: now,
  };
}

/**
 * A stage that WORKS. There is no `waitUntil` parameter and there never will be
 * one: the only thing this side of the flow knows is how much is done, and
 * `3/10 photos` is a fact while "about 25 seconds left" is a guess (§3.2, §4.3).
 */
export function workingProgress(
  stage: PostJobWorkingStage,
  input: WorkingProgressInput,
): PostJobProgress {
  const now = safeDate(input?.now);
  // A waiting stage arriving here is a caller bug; falling back keeps the shape
  // valid AND keeps the waiting stage out, so no waiting stage can ever exist
  // without the deadline its constructor demands.
  const safeStage: PostJobStage =
    isPostJobStage(stage) && !isPostJobWaitingStage(stage) ? stage : "waiting_in_queue";
  const counts = safeCounts(input?.doneCount, input?.totalCount);
  return {
    stage: safeStage,
    attempt: safeAttempt(input?.attempt),
    doneCount: counts.done,
    totalCount: counts.total,
    currentItem: safeItem(input?.currentItem),
    stageStartedAt: now,
    waitUntil: null,
    updatedAt: now,
  };
}

/**
 * ONE Vietnamese sentence for the operator screen. Same discipline as
 * `postJobOperatorMessage`: pure, no clock, no countdown — the remaining time is
 * counted in the browser from `waitUntil`, so a 3-second poll does not make the
 * screen say "còn 45 giây" three seconds too long.
 */
export function postJobProgressMessage(progress: PostJobProgress): string {
  const stage = isPostJobStage(progress?.stage) ? progress.stage : null;
  if (!stage) return "Không rõ bài đang ở bước nào — kiểm tra trạng thái bài đăng";

  const attempt = safeAttempt(progress?.attempt);
  const suffix = attempt > 1 ? ` (lần thử ${attempt})` : "";
  return `${stageSentence(stage, progress)}${suffix}`;
}

function stageSentence(stage: PostJobStage, progress: PostJobProgress): string {
  switch (stage) {
    case "waiting_in_queue":
      return "Đang chờ trong hàng đợi để đăng";
    case "waiting_for_spacing":
      return "Đang chờ giãn cách giữa các bài trên kênh này";
    case "waiting_for_schedule":
      return "Đã hẹn giờ — đang chờ tới lúc giao lịch cho Facebook";
    case "checking_stock":
      return "Đang kiểm tra tồn kho lần cuối trước khi đăng";
    case "reading_channel":
      return "Đang đọc cấu hình kênh";
    case "checking_video_spec":
      return "Đang kiểm tra thông số video";
    case "uploading_media":
      return uploadSentence(progress);
    case "sending_to_channel":
      return "Đang gửi bài lên kênh";
    case "handing_to_facebook":
      return "Đang giao lịch đăng cho Facebook";
    case "waiting_on_facebook":
      return "Facebook đã nhận lịch và đang giữ bài tới giờ đăng";
    case "done":
      return "Đã đăng xong";
    case "stopped":
      return "Bài đã dừng — xem lý do ở cột trạng thái";
  }
}

function uploadSentence(progress: PostJobProgress): string {
  const done = progress?.doneCount;
  const total = progress?.totalCount;
  const counts = typeof done === "number" && typeof total === "number" ? ` ${done}/${total}` : "";
  const item = safeItem(progress?.currentItem);
  return `Đang tải ảnh lên kênh${counts}${item ? ` (${item})` : ""}`;
}

/**
 * Labels of the horizontal stepper, in order. Exported so the screen does not
 * keep its own copy: a stage added here without a step would otherwise land on
 * whatever index the UI happened to hardcode.
 */
export const POST_JOB_PROGRESS_STEPS = [
  "Chờ hàng đợi",
  "Kiểm tồn",
  "Tải ảnh",
  "Gửi lên kênh",
  "Xong",
] as const;

/** A stage that is NOT on the stepper (a stopped job draws no step). */
export const PROGRESS_STEP_NONE = -1;

/**
 * Where the stage sits on the stepper, 0-based. `PROGRESS_STEP_NONE` for a
 * stopped job: it is not "at step 4", it is not on the line at all.
 */
export function progressStepIndex(stage: PostJobStage): number {
  switch (stage) {
    case "waiting_in_queue":
    case "waiting_for_spacing":
    case "waiting_for_schedule":
      return 0;
    case "checking_stock":
    case "reading_channel":
    case "checking_video_spec":
      return 1;
    case "uploading_media":
      return 2;
    case "sending_to_channel":
    case "handing_to_facebook":
    case "waiting_on_facebook":
      return 3;
    case "done":
      return 4;
    case "stopped":
      return PROGRESS_STEP_NONE;
    default:
      // Unknown text (an old Redis value, a newer worker) is not step 0: saying
      // "waiting in the queue" about a stage we cannot read would be a guess.
      return PROGRESS_STEP_NONE;
  }
}

// --- normalisers ------------------------------------------------------------

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Never returns an Invalid Date: a broken clock must not poison the store. */
function safeDate(value: unknown): Date {
  return isUsableDate(value) ? value : new Date(0);
}

/**
 * `attempt` is displayed, never computed with. A negative or fractional value
 * is a caller bug; it becomes 0 ("not counted") instead of throwing, because
 * this whole module is decoration (§3.1).
 */
function safeAttempt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored > 0 ? floored : 0;
}

/**
 * Counts only survive as a PAIR, and only when they describe something real:
 *
 *   total <= 0            -> nothing to count; both null (the bar goes
 *                            indeterminate instead of dividing by zero)
 *   done  > total         -> clamped to total; a bar past 100% is a bug the
 *                            operator cannot act on
 *   one of the two absent -> both null; "3 of ?" is not a progress bar
 */
function safeCounts(
  done: unknown,
  total: unknown,
): { done: number | null; total: number | null } {
  const totalNum = intOrNull(total);
  const doneNum = intOrNull(done);
  if (totalNum === null || totalNum <= 0 || doneNum === null) return { done: null, total: null };
  const clamped = Math.min(Math.max(doneNum, 0), totalNum);
  return { done: clamped, total: totalNum };
}

function intOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

function safeItem(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_CURRENT_ITEM_LENGTH
    ? `${trimmed.slice(0, MAX_CURRENT_ITEM_LENGTH)}…`
    : trimmed;
}
