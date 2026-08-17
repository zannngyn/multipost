/**
 * PostJob — ONE post on ONE channel (CLAUDE.md business rule 6, docs/02 §4).
 * Pure TypeScript: no imports outside core/domain (docs/07 §2).
 *
 * Everything here is a pure function over a plain object. Persistence lives in
 * adapters/db, the publish orchestration in core/usecases/publish-post.
 *
 * State machine (E7.1). No dangling state: every job is in exactly one of
 * these, and every move goes through `transitionPostJob`, which also carries the
 * reason so the audit trail can answer "why is this post not live?".
 *
 *   draft ──► queued ──► publishing ──► published        (happy path)
 *     │         │            │
 *     │         │            ├──► queued      (transient Graph error, retry left)
 *     │         │            ├──► failed      (retries exhausted)
 *     │         │            ├──► blocked     (out of stock / token / channel)
 *     │         │            │
 *     │         │            └──► scheduled_on_facebook ──► published
 *     │         │                        (E8.6 handoff)   ├──► blocked (cancelled
 *     │         │                                         │    / gone from Meta)
 *     │         │                                         └──► failed  (never
 *     │         │                                              confirmed)
 *     │         └──► blocked | failed
 *     └──► blocked | failed
 *
 *   failed ──► queued        (operator re-queues)
 *   blocked ──► queued       (operator fixed the cause and re-queues)
 *   published = FINAL. Nothing leaves it: the post exists on the platform, and
 *   a second publish is the worst bug this tool can have.
 *
 * `scheduled_on_facebook` is a state of its OWN (E8.6, PM decision): a queue job
 * that finished must never be read as "the platform accepted the schedule". The
 * post exists on Meta as an unpublished, scheduled object; only the
 * reconciliation sweep — which asks Graph — may move it to `published`.
 *
 * `blocked` vs `failed`:
 *   blocked — a rule said no (stock gate, token expired, channel missing). We
 *             did NOT call the platform. Retrying changes nothing until a human
 *             or another system acts. This is `cancelled` of docs/02 §4, renamed
 *             because "blocked" also covers operator-independent gates.
 *   failed  — we DID try and the platform refused, after all allowed attempts.
 */

import { AppError } from "./errors";

export const POST_JOB_STATUSES = [
  "draft",
  "queued",
  "publishing",
  /** E8.6 — handed over to the platform's own scheduler; not published yet. */
  "scheduled_on_facebook",
  "published",
  "failed",
  "blocked",
] as const;
export type PostJobStatus = (typeof POST_JOB_STATUSES)[number];

/** Phase 1 publishes image albums only; the other two land in Phase 2 (E5.3/E5.4). */
export const POST_FORMATS = ["image_post", "video_post", "reels"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

/**
 * Formats the composer may create. Phase 2 opened video + reels once the spec
 * gate existed on both sides (compose-time check in E3, upload-time re-check in
 * publish-post): a format is only "supported" when something can refuse a file
 * that does not fit it.
 */
export const SUPPORTED_FORMATS: readonly PostFormat[] = ["image_post", "video_post", "reels"];

/** @deprecated Kept as the old name of SUPPORTED_FORMATS; will be removed. */
export const PHASE_1_FORMATS: readonly PostFormat[] = SUPPORTED_FORMATS;

/** True for the two formats that carry exactly one video file. */
export function isVideoFormat(format: PostFormat): format is "video_post" | "reels" {
  return format === "video_post" || format === "reels";
}

/** Facebook allows at most 10 attachments on one feed post. */
export const MAX_ALBUM_MEDIA = 10;

/**
 * Explicit transition table. Written out as data (not `if` chains) so a review
 * can read the whole contract in one place and the tests can enumerate it.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PostJobStatus, readonly PostJobStatus[]>> = {
  // Created inside the batch transaction; enqueued right after.
  draft: ["queued", "blocked", "failed"],
  // `failed` here = the enqueue itself broke, so no worker ever saw the job.
  queued: ["publishing", "blocked", "failed"],
  publishing: ["published", "scheduled_on_facebook", "queued", "failed", "blocked"],
  /**
   * The post sits on Meta waiting for its hour. It NEVER goes back to `queued`:
   * re-queueing would upload the album a second time and Meta would publish two
   * posts at the same minute. An operator who changes their mind cancels (which
   * deletes the post on Meta first) and creates a new one.
   */
  scheduled_on_facebook: ["published", "failed", "blocked"],
  published: [],
  failed: ["queued"],
  blocked: ["queued"],
};

/** The only status a job never leaves. */
export const FINAL_POST_JOB_STATUSES: readonly PostJobStatus[] = ["published"];

/**
 * Statuses where nothing is running any more: the queue is done with the job and
 * only an operator (retry) can move it. Used to decide whether a BATCH is over.
 */
export const SETTLED_POST_JOB_STATUSES: readonly PostJobStatus[] = [
  "published",
  "failed",
  "blocked",
];

export interface PostJobMedia {
  readonly driveFileId: string;
  readonly fileName: string;
  /** Publicly fetchable URL handed to the platform. Validated at the boundary. */
  readonly url: string;
}

export interface PostJob {
  readonly id: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly productCode: string;
  /**
   * Canonical colour, or "" for "every colour of this code". NEVER null: the
   * anti-duplicate UNIQUE index must compare it, and in Postgres NULL != NULL
   * would let the same (batch, code, channel, format) be inserted twice.
   */
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
  readonly status: PostJobStatus;
  /** Publish attempts started (incremented when the job enters `publishing`). */
  readonly attemptCount: number;
  /** AppError code of the last failure/block. Free text: adapters add their own. */
  readonly lastErrorCode: string | null;
  /** Vietnamese operator message of that failure. */
  readonly lastErrorMessage: string | null;
  /** Platform post id — the proof a post exists. Set exactly once. */
  readonly publishedPostId: string | null;
  readonly publishedUrl: string | null;
  readonly publishedAt: Date | null;
  /**
   * E8.6 — id of the UNPUBLISHED post the platform is holding for us. Its own
   * column and NOT `publishedPostId` on purpose: that field's presence is what
   * the whole system reads as "this post is live", and a scheduled object is
   * exactly the case where an id exists and the post does not.
   * Needed to reconcile it (did Meta publish it?), and to delete it on a cancel.
   */
  readonly scheduledPostId: string | null;
  readonly captionText: string;
  readonly media: readonly PostJobMedia[];
  /** When this job should publish. Null = as soon as the worker picks it up. */
  readonly scheduledAt: Date | null;
  /**
   * Id of the queue entry currently representing this job (E8.4). Needed to
   * REMOVE a delayed job when an operator reschedules or cancels it: without it
   * the old entry would still fire and publish at the old time.
   * Null when nothing is queued (draft, blocked, published...).
   */
  readonly queueJobId: string | null;
}

export interface TransitionMeta {
  /** Machine-readable why, e.g. "STOCK_ZERO", "RETRY_AFTER_TRANSIENT_ERROR". */
  readonly reason?: string;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly publishedPostId?: string | null;
  readonly publishedUrl?: string | null;
  readonly publishedAt?: Date | null;
  /** Required when moving to `scheduled_on_facebook` (see PostJob). */
  readonly scheduledPostId?: string | null;
  /**
   * Drops `scheduledPostId` while stopping a job. For the ONE caller that can
   * honestly say the object is gone: a cancel the platform CONFIRMED. Everything
   * else keeps the id, because it is the trace of a post that may still exist —
   * and the reason a re-run of that row is refused.
   */
  readonly clearScheduledPostId?: boolean;
  /**
   * Queue entry that will carry this job. Set it in the SAME transition that
   * moves a job to `queued`, so the id is stored atomically with the state —
   * a `queued` row whose queue id was never written cannot be cancelled.
   */
  readonly queueJobId?: string | null;
}

export function isPostJobStatus(value: unknown): value is PostJobStatus {
  return typeof value === "string" && (POST_JOB_STATUSES as readonly string[]).includes(value);
}

export function isPostFormat(value: unknown): value is PostFormat {
  return typeof value === "string" && (POST_FORMATS as readonly string[]).includes(value);
}

export function isFinalPostJobStatus(status: PostJobStatus): boolean {
  return FINAL_POST_JOB_STATUSES.includes(status);
}

export function isSettledPostJobStatus(status: PostJobStatus): boolean {
  return SETTLED_POST_JOB_STATUSES.includes(status);
}

/** Statuses an operator may re-queue by hand (E11.1 "chạy lại"). */
export const RETRYABLE_POST_JOB_STATUSES: readonly PostJobStatus[] = ["failed", "blocked"];

export function isRetryablePostJobStatus(status: PostJobStatus): boolean {
  return RETRYABLE_POST_JOB_STATUSES.includes(status);
}

/**
 * E8.6 — the code a job carries when its handoff to the platform's scheduler
 * ended WITHOUT a verdict: the request that creates the post was dispatched (or
 * the publisher could not promise it was not), and nobody knows whether a
 * scheduled post now exists. Lives here, not in the usecase, because it is the
 * one thing on the ROW that later readers (retry, job log) must recognise.
 */
export const HANDOFF_FAILED_ERROR_CODE = "HANDOFF_FAILED";

/**
 * The reconciliation sweep asked Facebook about a handed-over post until the
 * give-up horizon and never got an answer it could believe (see
 * core/usecases/reconcile-scheduled-posts). The row keeps `scheduledPostId`, so
 * this is the case where a scheduled post is not merely possible: we hold its id.
 */
export const SCHEDULE_UNCONFIRMED_ERROR_CODE = "SCHEDULE_UNCONFIRMED";

/**
 * The reaper found a SCHEDULED job stuck in `publishing` (see
 * core/usecases/reap-post-jobs): a worker died between the claim and the answer,
 * with the creating request possibly already dispatched. Its own code, separate
 * from the reaper's plain PUBLISH_FAILED, because for a scheduled job the
 * evidence is invisible in the feed — the post, if it exists, sits in the Page's
 * *scheduled* posts — and a plain PUBLISH_FAILED is a row an operator may re-run.
 */
export const PUBLISH_UNCONFIRMED_ERROR_CODE = "PUBLISH_UNCONFIRMED";

/**
 * Why a `failed` row may correspond to a post on the platform. Ordered from the
 * strongest evidence (we hold the id) to the weakest (a request was dispatched
 * and nobody heard back).
 */
export const UNCONFIRMED_PLATFORM_POST_REASONS = [
  /** The row carries the id of an object the platform created for this job. */
  "PLATFORM_HOLDS_SCHEDULED_POST",
  /** The handoff call ended without a verdict (HANDOFF_FAILED). */
  "HANDOFF_OUTCOME_UNKNOWN",
  /** The sweep gave up confirming a handed-over post (SCHEDULE_UNCONFIRMED). */
  "SCHEDULE_UNCONFIRMED",
  /** A scheduled job died mid-publish and was reaped (PUBLISH_UNCONFIRMED). */
  "PUBLISH_OUTCOME_UNKNOWN",
] as const;
export type UnconfirmedPlatformPostReason = (typeof UNCONFIRMED_PLATFORM_POST_REASONS)[number];

/**
 * THE row-level half of business rule 4: why this `failed` job must not go back
 * into the publish flow — or null when nothing suggests a post exists.
 *
 * Nothing may move such a row back into the publish flow. Every road out of
 * `queued` ends on the Page: inside T-30..T-12 another handoff asks for a SECOND
 * scheduled post, between T-12 and T the job waits and then publishes at T, and
 * after T it publishes immediately — each one lands next to whatever the first
 * attempt left behind.
 *
 * FOUR ways a row gets here, and they must all answer the same, because the
 * operator-facing difference between them is only which sentence to print:
 *
 *   a) `scheduledPostId` present. `transitionPostJob` keeps that column when a
 *      job moves to `failed`, on purpose: the id is the proof the platform
 *      created something. It is checked FIRST and needs no error code, so a code
 *      nobody thought of still fails closed.
 *   b) HANDOFF_FAILED — the handoff call gave no verdict.
 *   c) SCHEDULE_UNCONFIRMED — the sweep gave up (and the row also matches (a),
 *      which is why (a) alone would already be enough; the code stays listed so
 *      the guard survives a row whose id was cleared by hand).
 *   d) PUBLISH_UNCONFIRMED — a scheduled job was reaped out of `publishing`.
 *
 * `scheduledAt` is deliberately NOT part of any condition: it would silently
 * disable the guard for a row whose hour went missing, and this predicate must
 * fail closed.
 *
 * A successful CANCEL is not here and must not be: it leaves `blocked` (only
 * after Facebook confirmed it no longer holds the post), so "huỷ rồi đổi ý" is
 * still one click away.
 */
export function unconfirmedPlatformPostReason(
  job:
    | Pick<PostJob, "status" | "lastErrorCode" | "scheduledPostId">
    | null
    | undefined,
): UnconfirmedPlatformPostReason | null {
  if (!job || job.status !== "failed") return null;
  if (normaliseString(job.scheduledPostId) !== null) return "PLATFORM_HOLDS_SCHEDULED_POST";
  switch (normaliseString(job.lastErrorCode)) {
    case HANDOFF_FAILED_ERROR_CODE:
      return "HANDOFF_OUTCOME_UNKNOWN";
    case SCHEDULE_UNCONFIRMED_ERROR_CODE:
      return "SCHEDULE_UNCONFIRMED";
    case PUBLISH_UNCONFIRMED_ERROR_CODE:
      return "PUBLISH_OUTCOME_UNKNOWN";
    default:
      return null;
  }
}

/** True when the platform MAY already be holding a post for this job. */
export function mayHoldUnconfirmedScheduledPost(
  job:
    | Pick<PostJob, "status" | "lastErrorCode" | "scheduledPostId">
    | null
    | undefined,
): boolean {
  return unconfirmedPlatformPostReason(job) !== null;
}

/**
 * The single answer to "may an operator press Chạy lại on this row?" — used by
 * the job log (to not draw the button) and by the retry usecase (to refuse it).
 * One function so the screen and the rule can never disagree; a new refusal
 * belongs INSIDE it, never next to it.
 */
export function canOperatorRetryPostJob(
  job:
    | Pick<PostJob, "status" | "lastErrorCode" | "scheduledPostId">
    | null
    | undefined,
): boolean {
  if (!job || !isPostJobStatus(job.status)) return false;
  return isRetryablePostJobStatus(job.status) && !mayHoldUnconfirmedScheduledPost(job);
}

export function canTransitionPostJob(from: PostJobStatus, to: PostJobStatus): boolean {
  if (!isPostJobStatus(from) || !isPostJobStatus(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedTransitionsFrom(from: PostJobStatus): readonly PostJobStatus[] {
  return isPostJobStatus(from) ? ALLOWED_TRANSITIONS[from] : [];
}

/**
 * The single door between two states. Returns a NEW job (no mutation) or throws
 * INVALID_JOB_TRANSITION — including for the payload rules that make a state
 * meaningful (a `published` job without a post id is a lost link; a `blocked`
 * job without an error code is an unexplained dead post).
 */
export function transitionPostJob(
  job: PostJob,
  to: PostJobStatus,
  meta: TransitionMeta = {},
): PostJob {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (!job || typeof job !== "object" || !isPostJobStatus(job.status)) {
    throw new AppError("INVALID_JOB_TRANSITION", {
      message: "transitionPostJob received a job without a valid status",
      context: { to, job_status: (job as { status?: unknown } | null)?.status ?? null },
    });
  }
  if (!isPostJobStatus(to)) {
    throw new AppError("INVALID_JOB_TRANSITION", {
      message: `Unknown target status "${String(to)}"`,
      context: { job_id: job.id, from: job.status, to },
    });
  }
  if (!canTransitionPostJob(job.status, to)) {
    throw new AppError("INVALID_JOB_TRANSITION", {
      message: `Post job cannot move from ${job.status} to ${to}`,
      userMessage: `Bài đăng đang ở trạng thái "${job.status}" nên không thể chuyển sang "${to}".`,
      context: {
        job_id: job.id,
        tenant_id: job.tenantId,
        batch_id: job.batchId,
        product_code: job.productCode,
        channel: job.channelId,
        from: job.status,
        to,
        allowed: ALLOWED_TRANSITIONS[job.status],
        reason: meta.reason ?? null,
      },
    });
  }

  if (to === "scheduled_on_facebook") {
    // Without the remote id nothing can reconcile or delete this post, and Meta
    // will publish it at its hour anyway: an unidentified scheduled object is a
    // post nobody can stop.
    const scheduledPostId = normaliseString(meta.scheduledPostId);
    if (!scheduledPostId) {
      throw new AppError("INVALID_JOB_TRANSITION", {
        message: "A scheduled_on_facebook post job requires the platform post id",
        userMessage:
          "Không ghi nhận được mã bài đã hẹn trên kênh — không thể đánh dấu đã giao lịch.",
        context: { job_id: job.id, tenant_id: job.tenantId, channel: job.channelId },
      });
    }
    return {
      ...job,
      status: "scheduled_on_facebook",
      scheduledPostId,
      // The handoff succeeded: an earlier attempt's error is history.
      lastErrorCode: null,
      lastErrorMessage: null,
      // The platform holds the post now; no queue entry represents it any more.
      // Keeping a stale id would let a cancel drop someone else's entry.
      queueJobId: null,
    };
  }

  if (to === "published") {
    const postId = normaliseString(meta.publishedPostId);
    if (!postId) {
      throw new AppError("INVALID_JOB_TRANSITION", {
        message: "A published post job requires the platform post id",
        userMessage: "Không ghi nhận được mã bài trên kênh — không thể đánh dấu đã đăng.",
        context: { job_id: job.id, tenant_id: job.tenantId, channel: job.channelId },
      });
    }
    return {
      ...job,
      status: "published",
      publishedPostId: postId,
      publishedUrl: normaliseString(meta.publishedUrl),
      publishedAt: meta.publishedAt ?? new Date(),
      // The post is live: whatever failed on an earlier attempt is history.
      lastErrorCode: null,
      lastErrorMessage: null,
      // Nothing is queued any more; keeping a stale id would let a cancel or a
      // reschedule remove someone else's queue entry later.
      queueJobId: null,
    };
  }

  if (to === "blocked" || to === "failed") {
    const errorCode = normaliseString(meta.errorCode);
    if (!errorCode) {
      throw new AppError("INVALID_JOB_TRANSITION", {
        message: `Moving a post job to ${to} requires an error code`,
        userMessage: "Thiếu lý do khi dừng bài đăng — không ghi nhận trạng thái mơ hồ.",
        context: { job_id: job.id, tenant_id: job.tenantId, from: job.status, to },
      });
    }
    return {
      ...job,
      status: to,
      lastErrorCode: errorCode,
      lastErrorMessage: normaliseString(meta.errorMessage),
      // A stopped job owns no queue entry (the caller removes it).
      queueJobId: null,
      // `scheduledPostId` is KEPT by default. A job that stops after the
      // platform accepted a schedule still has a post on the Page, and that id
      // is the only trace of it: clearing it would erase the very fact
      // `unconfirmedPlatformPostReason` reads to refuse a re-run, and leave the
      // operator with no id to search for.
      //
      // The exception is a CONFIRMED cancel: the object is gone, and keeping a
      // dead id would refuse the re-run of a job that has nothing on the Page
      // (cancel -> retry -> ordinary failure would otherwise carry it forever).
      scheduledPostId: meta.clearScheduledPostId === true ? null : job.scheduledPostId,
    };
  }

  if (to === "publishing") {
    // Counting here (not at the publish call) means a worker that dies mid-call
    // still leaves the attempt on record.
    return { ...job, status: "publishing", attemptCount: job.attemptCount + 1 };
  }

  // draft -> queued, publishing -> queued (retry), failed/blocked -> queued.
  return {
    ...job,
    status: "queued",
    lastErrorCode: normaliseString(meta.errorCode) ?? job.lastErrorCode,
    lastErrorMessage: normaliseString(meta.errorMessage) ?? job.lastErrorMessage,
    queueJobId: normaliseString(meta.queueJobId) ?? job.queueJobId,
  };
}

// --- Scheduling (E8) --------------------------------------------------------

/**
 * How far ahead a post may be scheduled.
 * PENDING(E8-window): the brief only says "chọn ngày giờ cụ thể" without a
 * ceiling. 30 days is a deliberate guard, not a product rule: a signed media URL
 * lives 6h and a Page token ~60 days, so a post scheduled for next year would
 * fail on credentials nobody remembers granting.
 */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Smallest gap that still counts as "later". Below it, "hẹn giờ" is really
 * "đăng ngay" and the delay is not worth a queue round trip.
 */
export const MIN_SCHEDULE_AHEAD_MS = 1_000;

export const SCHEDULE_REJECTIONS = ["NOT_A_DATE", "IN_THE_PAST", "TOO_FAR_AHEAD"] as const;
export type ScheduleRejection = (typeof SCHEDULE_REJECTIONS)[number];

export type ScheduleVerdict =
  | { readonly ok: true; readonly at: Date; readonly delayMs: number }
  /** `at` is kept when parsable, so the caller can name it in the message. */
  | { readonly ok: false; readonly reason: ScheduleRejection; readonly at: Date | null };

/**
 * Validates one requested publish time. Returns a verdict (never throws) so a
 * per-channel loop can reject ONE channel without losing the others — the same
 * rule as fan-out (business rule 6).
 */
export function evaluateScheduledAt(
  scheduledAt: unknown,
  nowMs: number,
  maxAheadMs: number = MAX_SCHEDULE_AHEAD_MS,
): ScheduleVerdict {
  // --- Edge cases first -----------------------------------------------------
  const at = toDate(scheduledAt);
  if (!at) return { ok: false, reason: "NOT_A_DATE", at: null };
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "NOT_A_DATE", at };

  const delayMs = at.getTime() - nowMs;
  // A time already gone is a mistake (typo, wrong timezone, stale form), never
  // "post immediately": silently publishing NOW is the surprise nobody wants.
  if (delayMs < MIN_SCHEDULE_AHEAD_MS) return { ok: false, reason: "IN_THE_PAST", at };
  if (delayMs > maxAheadMs) return { ok: false, reason: "TOO_FAR_AHEAD", at };
  return { ok: true, at, delayMs };
}

/** Vietnamese explanation for a rejected time — shown next to the channel row. */
export function scheduleRejectionMessage(reason: ScheduleRejection, maxAheadMs = MAX_SCHEDULE_AHEAD_MS): string {
  switch (reason) {
    case "NOT_A_DATE":
      return "Giờ hẹn đăng không hợp lệ.";
    case "IN_THE_PAST":
      return "Giờ hẹn đăng đã trôi qua — hãy chọn một thời điểm trong tương lai.";
    case "TOO_FAR_AHEAD":
      return `Chỉ được hẹn đăng trong vòng ${Math.floor(maxAheadMs / (24 * 60 * 60 * 1000))} ngày.`;
    default:
      return "Giờ hẹn đăng không hợp lệ.";
  }
}

/** True while the job is waiting for its scheduled time (nothing published yet). */
export function isPendingSchedule(
  job: Pick<PostJob, "status" | "scheduledAt">,
  nowMs: number,
): boolean {
  if (job.status !== "queued" && job.status !== "scheduled_on_facebook") return false;
  if (!(job.scheduledAt instanceof Date)) return false;
  return job.scheduledAt.getTime() > nowMs;
}

// --- Handoff to the platform's own scheduler (E8.6) --------------------------

/**
 * MEASURED on a real Page (unpublished probe posts, deleted afterwards):
 *
 *   +5m +6m +7m +8m                        -> Graph #100 "scheduled publish
 *                                             time is invalid"
 *   +9m +10m +11m +12m +15m +1d ... +29d   -> accepted
 *   +30d +75d +200d                        -> refused
 *
 * So Meta wants at least ~9-10 minutes of lead and less than 30 days. Do not
 * "round" these numbers without re-running the probe.
 */
export const HANDOFF_MIN_LEAD_MS = 10 * 60 * 1000;

/** First attempt: the worker wakes up 30' before the hour. */
export const HANDOFF_WINDOW_START_MS = 30 * 60 * 1000;

/**
 * LAST attempt, and it is T-12 rather than T-10 on purpose: a 10-photo album
 * took 41.8s to upload on a fast link and can take minutes on a slow Drive. A
 * handoff started at T-10 would call /feed with less than the measured minimum
 * lead and Meta would refuse the whole post.
 */
export const HANDOFF_DEADLINE_MS = 12 * 60 * 1000;

/** Gap between two attempts inside the window (30' - 12' = ~3 more chances). */
export const HANDOFF_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export type ScheduledPublishPlan =
  /** Nothing to do yet; come back in `wakeInMs`. */
  | {
      readonly action: "wait";
      readonly wakeInMs: number;
      readonly reason:
        | "BEFORE_HANDOFF_WINDOW"
        | "TOO_LATE_TO_HAND_OFF"
        /** This post cannot be handed over at all (video, or a platform without a scheduler). */
        | "HANDOFF_NOT_AVAILABLE";
    }
  /** Inside the window: upload and hand the post to the platform. */
  | { readonly action: "hand_off"; readonly leadMs: number }
  /** The hour has come (or gone): publish through the normal path, right now. */
  | { readonly action: "publish_now"; readonly lateByMs: number };

/**
 * What should happen to a scheduled job at this instant. Pure, so the worker,
 * the tests and any future screen read the SAME window.
 *
 *      T-30 ────────────── T-12 ────── T ──────►
 *        │   hand off       │  wait     │ publish now (late)
 *   wait │                  │           │
 *
 * Two deliberate choices:
 *   - between T-12 and T we WAIT for T instead of publishing early. The operator
 *     picked that hour; a post going out 11 minutes early is a surprise, and the
 *     queue only has to hold it for minutes (the reaper covers a lost entry).
 *   - after T we publish immediately and the caller records that the post went
 *     out LATE. Not publishing at all would be the worse answer (business rule
 *     5: nothing is silently dropped).
 *
 * A job with no scheduled time is an immediate post: `publish_now`, 0ms late.
 */
export function planScheduledPublish(
  scheduledAt: Date | null | undefined,
  nowMs: number,
  options: {
    readonly windowStartMs?: number;
    readonly deadlineMs?: number;
    /**
     * False for a post this system cannot hand over (a video, or a platform
     * with no scheduler of its own): it then simply waits for its hour, which is
     * the pre-E8.6 behaviour.
     */
    readonly canHandOff?: boolean;
  } = {},
): ScheduledPublishPlan {
  // --- Edge cases first -----------------------------------------------------
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
    return { action: "publish_now", lateByMs: 0 };
  }
  if (!Number.isFinite(nowMs)) {
    return { action: "publish_now", lateByMs: 0 };
  }
  const windowStartMs = positiveMsOr(options.windowStartMs, HANDOFF_WINDOW_START_MS);
  const deadlineMs = positiveMsOr(options.deadlineMs, HANDOFF_DEADLINE_MS);

  const remainingMs = scheduledAt.getTime() - nowMs;
  // Math.max keeps "exactly on time" at +0 instead of -0, which a strict
  // comparison in a test (or a JSON log) would show as "-0".
  if (remainingMs <= 0) return { action: "publish_now", lateByMs: Math.max(0, -remainingMs) };
  if (options.canHandOff === false) {
    return { action: "wait", wakeInMs: remainingMs, reason: "HANDOFF_NOT_AVAILABLE" };
  }
  if (remainingMs > windowStartMs) {
    return {
      action: "wait",
      wakeInMs: remainingMs - windowStartMs,
      reason: "BEFORE_HANDOFF_WINDOW",
    };
  }
  if (remainingMs >= deadlineMs) return { action: "hand_off", leadMs: remainingMs };
  return { action: "wait", wakeInMs: remainingMs, reason: "TOO_LATE_TO_HAND_OFF" };
}

/**
 * When to try the handoff again after a failed attempt.
 *
 * `intervalMs` while another full attempt still fits before the deadline;
 * otherwise the wait until T itself, so the fallback publish happens AT the
 * requested hour instead of minutes early.
 */
export function nextHandoffAttemptDelayMs(
  scheduledAt: Date,
  nowMs: number,
  options: {
    readonly intervalMs?: number;
    readonly deadlineMs?: number;
  } = {},
): number {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) return 0;
  const intervalMs = positiveMsOr(options.intervalMs, HANDOFF_RETRY_INTERVAL_MS);
  const deadlineMs = positiveMsOr(options.deadlineMs, HANDOFF_DEADLINE_MS);

  const lastPossibleStartMs = scheduledAt.getTime() - deadlineMs;
  if (nowMs + intervalMs <= lastPossibleStartMs) return intervalMs;
  return Math.max(0, scheduledAt.getTime() - nowMs);
}

/**
 * Delay of the FIRST queue entry of a scheduled job: it wakes at the start of
 * the handoff window, not at the hour itself.
 */
export function handoffWakeDelayMs(
  scheduledAt: Date | null | undefined,
  nowMs: number,
  windowStartMs: number = HANDOFF_WINDOW_START_MS,
): number {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) return 0;
  return Math.max(0, scheduledAt.getTime() - nowMs - positiveMsOr(windowStartMs, HANDOFF_WINDOW_START_MS));
}

/** Unix SECONDS, which is what Meta's `scheduled_publish_time` expects. */
export function toUnixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function positiveMsOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

// --- Anti-duplicate key (business rule 4) -----------------------------------

export interface PostJobKeyParts {
  readonly tenantId: string;
  readonly batchId: string;
  readonly productCode: string;
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
}

/**
 * The tuple the DB enforces as UNIQUE (docs/02 §4). Returned as a string only
 * for logs and for the publisher's tracing key — the LOCK is the unique index,
 * never this string (a broker id is best-effort, see core/ports/job-queue.ts).
 *
 * TENANT ID IS PART OF THE KEY (gate note #3, decided here): the DB constraint
 * is (tenant_id, batch_id, product_code, color, channel_id, format), so leaving
 * the tenant out made the logged/traced key a DIFFERENT tuple from the one that
 * actually protects us — a reviewer reading a log line could not tell whether
 * two identical keys were the same row. Batch ids are UUIDs, so collisions
 * across tenants were not a real risk, but "the key in the log == the key in the
 * index" is worth more than the four characters saved.
 *
 * Cheap because nothing derives an identifier from this string: queue ids come
 * from `postJobQueueId` (post job UUID), and the publisher only traces it.
 */
export function postJobDuplicateKey(parts: PostJobKeyParts): string {
  return [
    parts.tenantId.trim(),
    parts.batchId,
    parts.productCode.trim().toUpperCase(),
    parts.color.trim().toUpperCase(),
    parts.channelId.trim(),
    parts.format,
  ].join("|");
}

const QUEUE_ID_MAX_LENGTH = 255;
const QUEUE_ID_PREFIX = "pp";

/** BullMQ builds Redis keys from the id: only [A-Za-z0-9._-] survives. */
function sanitiseIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Queue id for a post job. The POST JOB ID comes first on purpose: sanitising
 * Vietnamese colours collapses characters ("Tím" and "Tôm" both become "T-m"),
 * so a key built from the business tuple alone could silently merge two
 * different jobs into one queue entry — one post would never be enqueued.
 * The uuid keeps it unique; the readable tail is for humans watching Redis.
 */
export function postJobQueueId(job: Pick<PostJob, "id" | "productCode" | "color" | "channelId">): string {
  const readable = [job.productCode, job.color || "all", job.channelId]
    .map(sanitiseIdPart)
    .filter((part) => part.length > 0)
    .join(".");
  return `${QUEUE_ID_PREFIX}.${sanitiseIdPart(job.id)}.${readable}`.slice(0, QUEUE_ID_MAX_LENGTH);
}

/**
 * Queue id for a RE-enqueue (spacing deferral). It must differ from the id of
 * the job currently running: BullMQ ignores an `add` whose id still exists in
 * the retained set, which would drop the deferred post entirely.
 */
export function deferredPostJobQueueId(
  job: Pick<PostJob, "id" | "productCode" | "color" | "channelId">,
  attemptOrStamp: number,
): string {
  const suffix = `.d${Math.max(0, Math.trunc(attemptOrStamp))}`;
  return `${postJobQueueId(job).slice(0, QUEUE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
}

// --- Batch summary (brief §6: end-of-run table) -----------------------------

export const POST_BATCH_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  /** Every job was stopped by a RULE; the platform was never called. */
  "blocked",
  "failed",
] as const;
export type PostBatchStatus = (typeof POST_BATCH_STATUSES)[number];

/**
 * Batch status derived from its jobs — never written independently, so it can
 * never disagree with them.
 *
 *   no job yet / all draft      -> pending
 *   any job still moving        -> running
 *   all published               -> completed
 *   some published, some not    -> partial   (rule 6: one channel failing is not
 *                                             a batch failure)
 *   none published, all blocked -> blocked   (gate note #2: a sold-out code or a
 *                                             missing channel is NOT a failure of
 *                                             the tool — nothing was even sent.
 *                                             The operator screen must say
 *                                             "chặn" so the fix is obvious.)
 *   none published, any failed  -> failed    (we did call the platform and lost;
 *                                             mixed blocked+failed stays `failed`
 *                                             because a real failure happened and
 *                                             must not be softened away.)
 */
export function deriveBatchStatus(statuses: readonly PostJobStatus[]): PostBatchStatus {
  if (!Array.isArray(statuses) || statuses.length === 0) return "pending";
  if (statuses.every((status) => status === "draft")) return "pending";
  if (
    statuses.some(
      (status) =>
        status === "draft" ||
        status === "queued" ||
        status === "publishing" ||
        // Meta holds it but nothing is live yet — the batch is NOT finished.
        status === "scheduled_on_facebook",
    )
  ) {
    return "running";
  }
  const published = statuses.filter((status) => status === "published").length;
  if (published === statuses.length) return "completed";
  if (published > 0) return "partial";
  if (statuses.every((status) => status === "blocked")) return "blocked";
  return "failed";
}

/**
 * "Vì sao bài này không lên?" in one Vietnamese sentence, for the batch summary
 * (E7.5) and the job log (E11.1). Pure: it only reads the job row, so the same
 * text appears in the API, the UI and the smoke output.
 *
 * A stored `lastErrorMessage` always wins — it was written by whoever knew the
 * real cause (stock gate, Graph error map, queue failure).
 */
export function postJobOperatorMessage(
  job: Pick<
    PostJob,
    | "status"
    | "lastErrorCode"
    | "lastErrorMessage"
    | "publishedPostId"
    | "attemptCount"
    | "scheduledAt"
    | "scheduledPostId"
  >,
): string {
  const stored = normaliseString(job.lastErrorMessage);
  switch (job.status) {
    case "published":
      return `Đã đăng lên kênh (mã bài ${job.publishedPostId ?? "?"})`;
    case "draft":
      return "Bài đã soạn nhưng chưa được đưa vào hàng đợi";
    case "queued":
      return "Đang chờ trong hàng đợi để đăng";
    case "publishing":
      return `Đang gửi lên kênh (lần thử ${job.attemptCount})`;
    case "scheduled_on_facebook":
      return `Facebook đã nhận lịch và sẽ tự đăng lúc ${
        job.scheduledAt instanceof Date ? job.scheduledAt.toISOString() : "giờ đã hẹn"
      } (mã bài ${job.scheduledPostId ?? "?"})`;
    case "blocked":
      return (
        stored ??
        `Bài bị chặn trước khi gửi lên kênh (mã lỗi ${job.lastErrorCode ?? "không rõ"})`
      );
    case "failed":
      return (
        stored ??
        `Đăng thất bại sau ${job.attemptCount} lần thử (mã lỗi ${job.lastErrorCode ?? "không rõ"})`
      );
    default:
      return "Trạng thái bài đăng không xác định — cần kiểm tra thủ công";
  }
}

function normaliseString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
