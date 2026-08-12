import { AppError } from "@/core/domain/errors";
import { evaluateProductInventory } from "@/core/domain/inventory";
import {
  deferredPostJobQueueId,
  postJobDuplicateKey,
  transitionPostJob,
  type PostJob,
  type PostJobMedia,
  type PostJobStatus,
  type TransitionMeta,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type {
  ChannelConfigRepo,
  ChannelPublisher,
  SignMediaUrlFn,
} from "@/core/ports/publisher";

/**
 * E7.4 — publish ONE post job on ONE channel. Called by the worker (queued /
 * scheduled / retried) and, in Phase 1, by nothing else: "publish now" also goes
 * through the queue so there is exactly one publish path (docs/07 §3.4).
 *
 * Order is the whole point (business rules 3 + 4):
 *
 *   1. load + status guard   — published/publishing are never published again
 *   2. spacing gate          — too soon on this channel? re-enqueue, stay queued
 *   3. CLAIM queued->publishing (optimistic, WHERE status='queued')
 *   4. STOCK RECHECK         — the last gate before the API call, ALWAYS
 *   5. channel config        — token/page id from tenant_integration
 *   6. publish               — the only outbound call
 *   7. published + post id
 *
 * The spacing gate sits BEFORE the claim on purpose: a deferred job must stay
 * `queued` (it is queued), and a failing re-enqueue must not leave a job stuck
 * in `publishing`, which nothing auto-recovers (see the guard on step 1).
 */

/** Queue job name; the worker registers its handler under it. */
export const PUBLISH_POST_JOB_NAME = "publish-post";

export type PublishPostOutcome =
  | "published"
  /** The job was already live — a re-run after a crash. Nothing was called. */
  | "already_published"
  /** Spacing gate: re-enqueued with a delay, still queued. */
  | "deferred"
  /** A rule said no (stock, token, channel). The platform was NOT called. */
  | "blocked"
  /** Another worker owns it, or the job is not in a publishable state. */
  | "skipped";

export interface PublishPostInput {
  readonly tenantId: string;
  readonly postJobId: string;
  /** 1-based attempt of the QUEUE job (BullMQ decides whether one more runs). */
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

export interface PublishPostResult {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly batchId: string | null;
  readonly productCode: string | null;
  readonly channelId: string | null;
  readonly outcome: PublishPostOutcome;
  readonly status: PostJobStatus | null;
  readonly publishedPostId: string | null;
  readonly publishedUrl: string | null;
  readonly errorCode: string | null;
  /** Vietnamese, for the operator screen. */
  readonly userMessage: string | null;
  /** Set when outcome = "deferred". */
  readonly deferredMs: number | null;
}

export interface PublishPostDeps {
  postJobs: PostJobRepo;
  /** Same repo the compose step used — the recheck must read live stock. */
  products: ProductRepo;
  channels: ChannelConfigRepo;
  publisher: ChannelPublisher;
  /** Used only to re-enqueue a deferred job (spacing). */
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  /**
   * Re-mints the media URLs immediately before the API call. The link stored on
   * the job was signed when the batch was built; a job that waited for spacing
   * and two backed-off retries can outlive it (default TTL 6h), and Meta fetches
   * the photo AFTER we hand over the URL.
   */
  signMediaUrl: SignMediaUrlFn;
  /** Lazy: a missing MEDIA_PUBLIC_BASE_URL blocks the job, it never crashes boot. */
  mediaBaseUrl: () => string;
  mediaUrlTtlMs?: number;
}

export function makePublishPost(deps: PublishPostDeps) {
  return async function publishPost(input: PublishPostInput): Promise<PublishPostResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const postJobId = typeof input?.postJobId === "string" ? input.postJobId.trim() : "";
    if (!isTenantId(tenantId) || postJobId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "publishPost requires a tenant UUID and a post job id",
        userMessage: "Yêu cầu đăng bài thiếu thông tin định danh — đã từ chối.",
        context: { tenant_id: tenantId || null, post_job_id: postJobId || null },
      });
    }
    const attempt = positiveInt(input?.attempt) ?? 1;
    const maxAttemptsFromQueue = positiveInt(input?.maxAttempts);

    const job = await deps.postJobs.findJobById(tenantId, postJobId);
    if (!job) {
      // Not retryable: a missing row will not appear within a backoff window.
      throw new AppError("INVALID_INPUT", {
        message: "Post job not found",
        userMessage: "Không tìm thấy bài đăng cần xử lý — có thể đã bị xoá.",
        context: { tenant_id: tenantId, post_job_id: postJobId, reason: "POST_JOB_NOT_FOUND" },
      });
    }

    const log = deps.logger.child({
      tenant_id: tenantId,
      job_id: job.id,
      batch_id: job.batchId,
      product_code: job.productCode,
      channel: job.channelId,
    });

    // --- 1. Status guard — the anti-duplicate check at runtime ---------------
    if (job.status === "published") {
      // The crash scenario of business rule 4: the platform accepted the post,
      // the worker died before writing the status, the queue re-ran the job.
      log.info("Publish skipped: post job is already published", {
        outcome: "already_published",
        published_post_id: job.publishedPostId,
        attempt,
      });
      return result(job, "already_published", { deferredMs: null });
    }
    if (job.status !== "queued") {
      // `publishing` = another worker owns it, OR a previous run died mid-call.
      // Neither is safe to publish: a stuck `publishing` job needs an operator,
      // never an automatic second call to the platform.
      log.warn("Publish skipped: post job is not in a publishable state", {
        outcome: "skipped",
        error_code: job.lastErrorCode,
        job_status: job.status,
        attempt,
        reason:
          job.status === "publishing"
            ? "ANOTHER_WORKER_OR_CRASHED_RUN_OWNS_THIS_JOB"
            : "JOB_NOT_QUEUED",
      });
      return result(job, "skipped", { deferredMs: null });
    }

    const settings = await deps.channels.getPublishSettings(tenantId);
    const maxAttempts = maxAttemptsFromQueue ?? settings.maxAttempts;

    // --- 2. Spacing gate (brief §6, PENDING(E1): per channel) ----------------
    const lastPublishedAt = await deps.postJobs.findLastPublishedAt(tenantId, job.channelId);
    const waitMs = spacingWaitMs(lastPublishedAt, deps.clock.nowMs(), settings.spacingMs);
    if (waitMs > 0) {
      // A NEW queue id: BullMQ silently drops an `add` whose id is still
      // retained, which would lose this post entirely.
      await deps.queue.enqueue(
        PUBLISH_POST_JOB_NAME,
        { tenantId, postJobId: job.id },
        {
          jobId: deferredPostJobQueueId(job, deps.clock.nowMs()),
          delayMs: waitMs,
          attempts: maxAttempts,
          backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
        },
      );
      log.info("Publish deferred by the spacing gate", {
        outcome: "deferred",
        wait_ms: waitMs,
        spacing_ms: settings.spacingMs,
        last_published_at: lastPublishedAt?.toISOString() ?? null,
        attempt,
      });
      return result(job, "deferred", { deferredMs: waitMs });
    }

    // --- 3. Claim: queued -> publishing (optimistic) -------------------------
    const claimed = await move(deps, job, "publishing", { reason: "WORKER_CLAIMED" });
    if (!claimed) {
      log.warn("Publish skipped: lost the claim race for this job", {
        outcome: "skipped",
        reason: "CLAIM_RACE_LOST",
        attempt,
      });
      return result(job, "skipped", { deferredMs: null });
    }

    // --- 4. STOCK RECHECK, immediately before the API call (rule 3) ---------
    const product = await deps.products.findByCode(tenantId, claimed.productCode);
    if (!product) {
      const userMessage = `Không tìm thấy mã ${claimed.productCode} trên Sheet — không đăng`;
      const blocked = await block(deps, claimed, "PRODUCT_NOT_FOUND", userMessage, "PRODUCT_GONE");
      log.warn("Publish blocked: product disappeared from the snapshot", {
        outcome: "blocked",
        error_code: "PRODUCT_NOT_FOUND",
        attempt,
      });
      return result(blocked ?? claimed, "blocked", {
        deferredMs: null,
        errorCode: "PRODUCT_NOT_FOUND",
        userMessage,
      });
    }

    const inventory = evaluateProductInventory(product);
    if (inventory.blocked) {
      const userMessage =
        inventory.operatorMessage ?? `Mã ${claimed.productCode} đã hết hàng — không đăng`;
      const blocked = await block(
        deps,
        claimed,
        "OUT_OF_STOCK",
        userMessage,
        inventory.reason ?? "BLOCKED",
      );
      // PENDING(E3): the alert channel is undecided — log + DB row for now.
      log.warn("Publish blocked by the stock recheck — nothing was sent to the channel", {
        outcome: "blocked",
        error_code: "OUT_OF_STOCK",
        reason: inventory.reason,
        stock: inventory.stock,
        attempt,
        alert: "OPERATOR_ATTENTION",
      });
      return result(blocked ?? claimed, "blocked", {
        deferredMs: null,
        errorCode: "OUT_OF_STOCK",
        userMessage,
      });
    }
    if (inventory.operatorMessage) {
      // Internal warning only — brief §3 forbids it in the caption.
      log.info("Low stock warning (internal only)", {
        stock: inventory.stock,
        operator_message: inventory.operatorMessage,
      });
    }

    // --- 5. Channel credentials from tenant_integration ---------------------
    const channel = await deps.channels.findChannel(tenantId, claimed.channelId);
    if (!channel || channel.status !== "active") {
      const userMessage = `Kênh "${claimed.channelId}" chưa được cấu hình hoặc đang tắt — không đăng được`;
      const blocked = await block(
        deps,
        claimed,
        "CHANNEL_NOT_CONFIGURED",
        userMessage,
        channel ? "CHANNEL_DISABLED" : "CHANNEL_MISSING",
      );
      log.warn("Publish blocked: channel not usable", {
        outcome: "blocked",
        error_code: "CHANNEL_NOT_CONFIGURED",
        channel_status: channel?.status ?? "missing",
        attempt,
      });
      return result(blocked ?? claimed, "blocked", {
        deferredMs: null,
        errorCode: "CHANNEL_NOT_CONFIGURED",
        userMessage,
      });
    }

    // --- 6a. Fresh media URLs (E3.6) ----------------------------------------
    // Signed links are short-lived on purpose; the ones minted when the batch
    // was created may already be dead by the time this attempt runs.
    let media: readonly PostJobMedia[];
    try {
      const resigned = resignMedia(deps, claimed);
      media = resigned.media;
      log.debug("Media URLs re-signed for this attempt", {
        media_count: media.length,
        // Expiry only: the URL itself carries a MAC.
        media_url_expires_at: resigned.expiresAtMs
          ? new Date(resigned.expiresAtMs).toISOString()
          : null,
        attempt,
      });
    } catch (error) {
      const appError = AppError.from(error, "INVALID_INPUT", {
        tenant_id: tenantId,
        job_id: claimed.id,
        channel: claimed.channelId,
        reason: "MEDIA_URL_SIGNING_FAILED",
      });
      const userMessage =
        "Không tạo được liên kết ảnh công khai cho bài này — kiểm tra cấu hình MEDIA_PUBLIC_BASE_URL / khoá ký liên kết.";
      // Blocked, not failed: a retry cannot fix a configuration problem, and the
      // platform was never called.
      const blocked = await block(
        deps,
        claimed,
        appError.code,
        userMessage,
        "MEDIA_URL_SIGNING_FAILED",
      );
      log.error("Publish blocked: could not sign the media URLs", {
        err: appError,
        outcome: "blocked",
        error_code: appError.code,
        attempt,
        alert: "OPERATOR_ATTENTION",
      });
      return result(blocked ?? claimed, "blocked", {
        deferredMs: null,
        errorCode: appError.code,
        userMessage,
      });
    }

    // --- 6. Publish ---------------------------------------------------------
    const startedAt = deps.clock.nowMs();
    let published: { postId: string; url: string | null };
    try {
      published = await deps.publisher.publishImagePost({
        tenantId,
        channel,
        caption: claimed.captionText,
        media,
        idempotencyKey: postJobDuplicateKey(claimed),
      });
    } catch (error) {
      return await handlePublishError(deps, log, claimed, error, {
        attempt,
        maxAttempts,
        durationMs: deps.clock.nowMs() - startedAt,
      });
    }

    // --- 7. Published -------------------------------------------------------
    const done = await move(deps, claimed, "published", {
      reason: "PUBLISHED",
      publishedPostId: published.postId,
      publishedUrl: published.url,
      publishedAt: deps.clock.now(),
    });
    if (!done) {
      // The post EXISTS on the platform but the row moved under us. Never
      // silent: this needs a human to reconcile, so it is logged as an error
      // and thrown (a retry will hit the `published`/`skipped` guard, not the
      // platform).
      const appError = new AppError("INTERNAL", {
        message: "Post published but the job row was no longer in 'publishing'",
        userMessage:
          "Bài đã lên kênh nhưng hệ thống không ghi được trạng thái — cần kiểm tra thủ công.",
        context: {
          tenant_id: tenantId,
          job_id: claimed.id,
          channel: claimed.channelId,
          published_post_id: published.postId,
        },
      });
      log.error("Published but could not store the state", { err: appError, error_code: "INTERNAL" });
      throw appError;
    }

    await deps.postJobs.refreshBatchStatus(tenantId, claimed.batchId);
    log.info("Published", {
      outcome: "published",
      published_post_id: done.publishedPostId,
      published_url: done.publishedUrl,
      attempt,
      attempt_count: done.attemptCount,
      duration_ms: deps.clock.nowMs() - startedAt,
      media_count: done.media.length,
    });
    return result(done, "published", { deferredMs: null });
  };
}

export type PublishPost = ReturnType<typeof makePublishPost>;

// --- helpers ----------------------------------------------------------------

/**
 * Re-mints every media URL of the job. The stored URL is kept on the row as the
 * record of what was built; what goes to the platform is always freshly signed.
 *
 * A job created before signed URLs existed (no driveFileId) keeps its stored
 * URL — with a warning, so those rows are visible instead of silently failing.
 */
function resignMedia(
  deps: PublishPostDeps,
  job: PostJob,
): { media: readonly PostJobMedia[]; expiresAtMs: number | null } {
  if (!Array.isArray(job.media) || job.media.length === 0) {
    return { media: job.media, expiresAtMs: null };
  }

  const baseUrl = deps.mediaBaseUrl();
  let earliest = Number.POSITIVE_INFINITY;
  const media = job.media.map((item) => {
    const assetId = typeof item?.driveFileId === "string" ? item.driveFileId.trim() : "";
    if (assetId.length === 0) {
      deps.logger.warn("Media item without a drive file id — publishing the stored URL as is", {
        tenant_id: job.tenantId,
        job_id: job.id,
        file_name: item?.fileName ?? null,
        reason: "LEGACY_MEDIA_WITHOUT_ASSET_ID",
      });
      return item;
    }
    const signed = deps.signMediaUrl({
      tenantId: job.tenantId,
      assetId,
      baseUrl,
      ttlMs: deps.mediaUrlTtlMs,
    });
    earliest = Math.min(earliest, signed.expiresAtMs);
    return { driveFileId: assetId, fileName: item.fileName, url: signed.url };
  });
  return { media, expiresAtMs: Number.isFinite(earliest) ? earliest : null };
}

/**
 * Publish failed. Three outcomes, never a swallowed error:
 *   TOKEN_EXPIRED           -> blocked, no retry (a retry cannot mint a token)
 *   transient, retry left   -> back to `queued` + rethrow (BullMQ backs off)
 *   transient, last attempt -> `failed` + throw PUBLISH_FAILED
 */
async function handlePublishError(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  error: unknown,
  ctx: { attempt: number; maxAttempts: number; durationMs: number },
): Promise<PublishPostResult> {
  const appError = AppError.from(error, "META_ERROR", {
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
    attempt: ctx.attempt,
  });

  if (appError.code === "TOKEN_EXPIRED") {
    const userMessage = appError.userMessage;
    const blocked = await block(deps, job, "TOKEN_EXPIRED", userMessage, "TOKEN_EXPIRED");
    // PENDING(E3): alerting channel undecided — error log + DB row for now.
    log.error("Publish blocked: channel token expired or revoked", {
      err: appError,
      outcome: "blocked",
      error_code: "TOKEN_EXPIRED",
      attempt: ctx.attempt,
      duration_ms: ctx.durationMs,
      alert: "OPERATOR_ATTENTION",
    });
    return result(blocked ?? job, "blocked", {
      deferredMs: null,
      errorCode: "TOKEN_EXPIRED",
      userMessage,
    });
  }

  // Convention with every ChannelPublisher (see core/ports/publisher.ts):
  // `context.retryable === false` means the platform refused for a reason a
  // backoff cannot change (bad parameter, missing permission, policy block).
  const retryable = (appError.context as { retryable?: unknown }).retryable !== false;
  const willRetry = retryable && ctx.attempt < ctx.maxAttempts;
  if (willRetry) {
    await move(deps, job, "queued", {
      reason: "RETRY_AFTER_TRANSIENT_ERROR",
      errorCode: appError.code,
      errorMessage: appError.userMessage,
    });
    log.error("Publish failed, will retry", {
      err: appError,
      error_code: appError.code,
      attempt: ctx.attempt,
      max_attempts: ctx.maxAttempts,
      duration_ms: ctx.durationMs,
      will_retry: true,
    });
    // Rethrow: the queue adapter owns backoff, not this usecase.
    throw appError;
  }

  const finalError = new AppError("PUBLISH_FAILED", {
    message: `Publish failed after attempt ${ctx.attempt}/${ctx.maxAttempts}: ${appError.message}`,
    context: {
      ...appError.context,
      original_code: appError.code,
      max_attempts: ctx.maxAttempts,
      retryable: false,
    },
    cause: appError,
  });
  await move(deps, job, "failed", {
    reason: retryable ? "RETRIES_EXHAUSTED" : "NON_RETRYABLE_PLATFORM_ERROR",
    errorCode: "PUBLISH_FAILED",
    errorMessage: `${finalError.userMessage} (${appError.userMessage})`,
  });
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  log.error("Publish failed permanently", {
    err: finalError,
    error_code: "PUBLISH_FAILED",
    original_code: appError.code,
    attempt: ctx.attempt,
    max_attempts: ctx.maxAttempts,
    duration_ms: ctx.durationMs,
    will_retry: false,
    retryable_platform_error: retryable,
    alert: "OPERATOR_ATTENTION",
  });
  throw finalError;
}

/** Domain transition + optimistic DB write. Null = another writer won. */
async function move(
  deps: PublishPostDeps,
  job: PostJob,
  to: PostJobStatus,
  meta: TransitionMeta & { reason: string },
): Promise<PostJob | null> {
  const next = transitionPostJob(job, to, meta);
  return deps.postJobs.applyTransition({
    tenantId: job.tenantId,
    postJobId: job.id,
    from: job.status,
    next,
    reason: meta.reason,
  });
}

async function block(
  deps: PublishPostDeps,
  job: PostJob,
  errorCode: string,
  userMessage: string,
  reason: string,
): Promise<PostJob | null> {
  const blocked = await move(deps, job, "blocked", { reason, errorCode, errorMessage: userMessage });
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  return blocked;
}

function result(
  job: PostJob,
  outcome: PublishPostOutcome,
  extra: { deferredMs: number | null; errorCode?: string | null; userMessage?: string | null },
): PublishPostResult {
  return {
    tenantId: job.tenantId,
    postJobId: job.id,
    batchId: job.batchId,
    productCode: job.productCode,
    channelId: job.channelId,
    outcome,
    status: job.status,
    publishedPostId: job.publishedPostId,
    publishedUrl: job.publishedUrl,
    errorCode: extra.errorCode ?? job.lastErrorCode,
    userMessage: extra.userMessage ?? job.lastErrorMessage,
    deferredMs: extra.deferredMs,
  };
}

/** Milliseconds still to wait before this channel may post again. */
export function spacingWaitMs(
  lastPublishedAt: Date | null,
  nowMs: number,
  spacingMs: number,
): number {
  if (!lastPublishedAt || !(lastPublishedAt instanceof Date)) return 0;
  const last = lastPublishedAt.getTime();
  if (!Number.isFinite(last) || !Number.isFinite(spacingMs) || spacingMs <= 0) return 0;
  // A clock skew putting `last` in the future must not wait forever.
  const elapsed = nowMs - last;
  if (elapsed < 0) return Math.min(spacingMs, Math.abs(elapsed) + spacingMs);
  return elapsed >= spacingMs ? 0 : spacingMs - elapsed;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
