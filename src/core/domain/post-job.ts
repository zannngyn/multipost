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
 *     │         │            └──► blocked     (out of stock / token / channel)
 *     │         └──► blocked | failed
 *     └──► blocked | failed
 *
 *   failed ──► queued        (operator re-queues)
 *   blocked ──► queued       (operator fixed the cause and re-queues)
 *   published = FINAL. Nothing leaves it: the post exists on the platform, and
 *   a second publish is the worst bug this tool can have.
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
  "published",
  "failed",
  "blocked",
] as const;
export type PostJobStatus = (typeof POST_JOB_STATUSES)[number];

/** Phase 1 publishes image albums only; the other two land in Phase 2 (E5.3/E5.4). */
export const POST_FORMATS = ["image_post", "video_post", "reels"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export const PHASE_1_FORMATS: readonly PostFormat[] = ["image_post"];

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
  publishing: ["published", "queued", "failed", "blocked"],
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
  readonly captionText: string;
  readonly media: readonly PostJobMedia[];
  /** Phase 2 scheduling; stored today so the column does not move later. */
  readonly scheduledAt: Date | null;
}

export interface TransitionMeta {
  /** Machine-readable why, e.g. "STOCK_ZERO", "RETRY_AFTER_TRANSIENT_ERROR". */
  readonly reason?: string;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly publishedPostId?: string | null;
  readonly publishedUrl?: string | null;
  readonly publishedAt?: Date | null;
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
  };
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
  if (statuses.some((status) => status === "draft" || status === "queued" || status === "publishing")) {
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
  job: Pick<PostJob, "status" | "lastErrorCode" | "lastErrorMessage" | "publishedPostId" | "attemptCount">,
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
