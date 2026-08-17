import { AppError } from "@/core/domain/errors";
import { evaluateProductInventory } from "@/core/domain/inventory";
import {
  evaluateVideoSpec,
  summarizeViolations,
  type VideoSpecViolation,
  type VideoTarget as SpecVideoTarget,
} from "@/core/domain/video-spec";
import {
  deferredPostJobQueueId,
  HANDOFF_DEADLINE_MS,
  nextHandoffAttemptDelayMs,
  planScheduledPublish,
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
import type { MediaAssetLookup } from "@/core/ports/drive-source";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type { ReadMediaBytes } from "@/core/usecases/read-media-bytes";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelPublisher,
  PublishMediaItem,
  PublishSettings,
  SignMediaUrlFn,
  VideoTarget as PublisherVideoTarget,
} from "@/core/ports/publisher";

/**
 * E7.4 — publish ONE post job on ONE channel. Called by the worker (queued /
 * scheduled / retried) and, in Phase 1, by nothing else: "publish now" also goes
 * through the queue so there is exactly one publish path (docs/07 §3.4).
 *
 * Order is the whole point (business rules 3 + 4):
 *
 *   1. load + status guard   — published/publishing are never published again
 *   1c. handoff window (E8.6) — a scheduled post outside its window goes back to
 *                              the queue; nothing is claimed and nothing is sent
 *   2. spacing gate          — too soon on this channel? re-enqueue, stay queued
 *   3. CLAIM queued->publishing (optimistic, WHERE status='queued')
 *   4. STOCK RECHECK         — the last gate before the API call, ALWAYS
 *   5. channel config        — token/page id from tenant_integration
 *   6. publish OR hand off   — the only outbound call
 *   7. published + post id, or `scheduled_on_facebook` + the remote post id
 *
 * E8.6 — a scheduled IMAGE post is NOT published by this worker: between T-30
 * and T-12 it is uploaded and handed to Facebook with `scheduled_publish_time`,
 * so the post survives this process and Redis dying. The stock recheck and the
 * claim still run FIRST, before anything is uploaded: handing a sold-out product
 * to Facebook would publish it at the hour with nobody able to stop it.
 *
 * The spacing gate sits BEFORE the claim on purpose: a deferred job must stay
 * `queued` (it is queued), and a failing re-enqueue must not leave a job stuck
 * in `publishing`, which nothing auto-recovers (see the guard on step 1).
 */

/** Queue job name; the worker registers its handler under it. */
export const PUBLISH_POST_JOB_NAME = "publish-post";

/**
 * Audit actions that name the EVENT, not just the resulting status (E8.3/E8.5).
 * Kept here because the usecase decides when a block is an auto-cancellation.
 */
export const AUTO_CANCELLED_AUDIT_ACTION = "post_job.auto_cancelled";
export const SCHEDULED_FAILED_AUDIT_ACTION = "post_job.scheduled_publish_failed";
/** E8.6 — Facebook accepted the schedule and now holds the post. */
export const HANDED_OFF_AUDIT_ACTION = "post_job.scheduled_on_facebook";
/**
 * E8.6 — the handoff window closed without a handoff, so the post went out on
 * the normal path AFTER its hour. Its own event: nobody was watching at that
 * hour, and "it published, just late" must be answerable from the trail.
 */
export const LATE_PUBLISH_AUDIT_ACTION = "post_job.published_late";

/** Error code stored on a job that could not be handed over in time. */
export const HANDOFF_EXPIRED_ERROR_CODE = "HANDOFF_EXPIRED";
/**
 * Error code stored when a handoff ended WITHOUT a verdict: the platform may or
 * may not be holding a scheduled post for this job. The job stops there — see
 * failUnconfirmedHandoff for why neither a retry nor a publish at the hour is
 * allowed afterwards.
 */
export const HANDOFF_FAILED_ERROR_CODE = "HANDOFF_FAILED";
/**
 * The platform refused the SCHEDULE but created nothing (E8.6). The post is not
 * lost: it goes out on the normal path at its hour, and this code says why the
 * handoff did not happen.
 */
export const HANDOFF_REFUSED_ERROR_CODE = "HANDOFF_REFUSED";

export type PublishPostOutcome =
  | "published"
  /** The job was already live — a re-run after a crash. Nothing was called. */
  | "already_published"
  /** Spacing gate or handoff window: re-enqueued with a delay, still queued. */
  | "deferred"
  /** E8.6 — the platform accepted the schedule; it will publish at the hour. */
  | "scheduled_on_facebook"
  /** A rule said no (stock, token, channel). The platform was NOT called. */
  | "blocked"
  /** Another worker owns it, or the job is not in a publishable state. */
  | "skipped";

export interface PublishPostInput {
  readonly tenantId: string;
  readonly postJobId: string;
  /**
   * Id of the QUEUE entry that woke this run up (BullMQ `job.id`). Compared with
   * `post_job.queue_job_id` before anything is claimed: after a reschedule whose
   * old entry could not be removed, the OLD entry still fires at the OLD time —
   * and the status guard alone cannot tell the two apart, because the row is
   * legitimately `queued` for the NEW time.
   * Null/absent = no check (a caller that is not the queue).
   */
  readonly queueJobId?: string | null;
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
  /** E8.6 — id of the post the platform is holding, when it took the schedule. */
  readonly scheduledPostId: string | null;
  readonly errorCode: string | null;
  /** Vietnamese, for the operator screen. */
  readonly userMessage: string | null;
  /** Set when outcome = "deferred". */
  readonly deferredMs: number | null;
  /** Machine-readable why, when outcome = "skipped". */
  readonly skipReason: string | null;
}

export interface PublishPostDeps {
  postJobs: PostJobRepo;
  /** Same repo the compose step used — the recheck must read live stock. */
  products: ProductRepo;
  channels: ChannelConfigRepo;
  /**
   * One publisher per platform (E6). The CHANNEL decides which one runs: a
   * tenant with a Facebook Page and a TikTok account publishes the same product
   * through two different APIs, and neither may see the other's job.
   */
  publishers?: Partial<Record<ChannelPlatform, ChannelPublisher>>;
  /** Facebook publisher — the pre-E6 shape, still accepted as the default. */
  publisher?: ChannelPublisher;
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
  /**
   * E5.3 — the LAST video spec check, right before the upload. Optional for the
   * same reason the stock recheck is not: a process without ffprobe must still
   * be able to run (it warns), while the worker image carries the binary and
   * therefore makes the check binding.
   */
  videoProbe?: VideoAssetProbe;
  /** Resolves a post_job media item back to the synced asset the probe needs. */
  mediaAssets?: MediaAssetLookup;
  /**
   * E5 — reads ONE photo's bytes (cache first, then Drive / the blob store).
   * Required, not optional: the Facebook photo path uploads the bytes itself, so
   * a process without it could not publish an image post at all — and a silent
   * fallback to "let Facebook fetch the URL" is the bug this replaces.
   */
  readMediaBytes: ReadMediaBytes;
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

    // --- 1b. Stale queue entry guard (E8.4) ---------------------------------
    // A rescheduled job whose OLD entry survived (remove failed, or the message
    // was already in flight) would otherwise publish at the OLD hour, silently.
    const runningQueueJobId = str(input?.queueJobId);
    if (runningQueueJobId.length > 0 && job.queueJobId && runningQueueJobId !== job.queueJobId) {
      // Not an error: nothing is wrong with the job, this MESSAGE is obsolete.
      // Returning (instead of throwing) leaves the attempt counter, the status
      // and the audit trail untouched — the live entry still owns the job.
      log.warn("Publish skipped: this queue entry is stale (the post was rescheduled)", {
        outcome: "skipped",
        reason: "STALE_QUEUE_ENTRY",
        expected_queue_job_id: job.queueJobId,
        actual_queue_job_id: runningQueueJobId,
        scheduled_at: job.scheduledAt?.toISOString() ?? null,
        attempt,
      });
      return result(job, "skipped", { deferredMs: null, skipReason: "STALE_QUEUE_ENTRY" });
    }
    if (runningQueueJobId.length > 0 && !job.queueJobId) {
      // Rows created before migration 0005 carry no queue id; guarding on a null
      // would strand every one of them. Visible, but not blocking.
      log.debug("No queue id stored on this job — stale-entry guard skipped", {
        reason: "QUEUE_ID_NOT_STORED",
        actual_queue_job_id: runningQueueJobId,
      });
    }

    const settings = await deps.channels.getPublishSettings(tenantId);
    const maxAttempts = maxAttemptsFromQueue ?? settings.maxAttempts;

    // --- 1c. Handoff window (E8.6) ------------------------------------------
    // A scheduled IMAGE post is not published by this worker at all: it is
    // handed to Facebook, which holds it and publishes at the hour even if this
    // process (or Redis) dies in between. The window says what to do right now.
    // Videos keep the old behaviour (the queue waits for the hour).
    const plan = planScheduledPublish(job.scheduledAt, deps.clock.nowMs(), {
      canHandOff: job.format === "image_post",
    });
    if (plan.action === "wait") {
      // Still `queued`, nothing claimed, nothing sent: come back later.
      return await deferQueuedJob(deps, log, job, {
        delayMs: plan.wakeInMs,
        reason: plan.reason,
        settings,
        maxAttempts,
        attempt,
        logMessage: "Publish deferred: outside the handoff window",
        extraLog: {
          scheduled_at: job.scheduledAt?.toISOString() ?? null,
          plan: plan.reason,
        },
      });
    }

    // --- 2. Spacing gate (brief §6, PENDING(E1): per channel) ----------------
    const lastPublishedAt = await deps.postJobs.findLastPublishedAt(tenantId, job.channelId);
    const waitMs = spacingWaitMs(lastPublishedAt, deps.clock.nowMs(), settings.spacingMs);
    if (waitMs > 0) {
      return await deferQueuedJob(deps, log, job, {
        delayMs: waitMs,
        reason: "SPACING_GATE",
        settings,
        maxAttempts,
        attempt,
        logMessage: "Publish deferred by the spacing gate",
        extraLog: {
          spacing_ms: settings.spacingMs,
          last_published_at: lastPublishedAt?.toISOString() ?? null,
        },
      });
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
      // E8.3 — a SCHEDULED post killed by the stock recheck is an automatic
      // cancellation, not a plain block: the operator scheduled it hours ago and
      // must be able to see, in the audit trail, that the system withdrew it.
      const wasScheduled = claimed.scheduledAt instanceof Date;
      const blocked = await block(
        deps,
        claimed,
        "OUT_OF_STOCK",
        userMessage,
        inventory.reason ?? "BLOCKED",
        wasScheduled ? AUTO_CANCELLED_AUDIT_ACTION : undefined,
      );
      // PENDING(E3): the alert channel is undecided — log + DB row for now.
      log.warn(
        wasScheduled
          ? "Scheduled post auto-cancelled by the stock recheck — nothing was sent to the channel"
          : "Publish blocked by the stock recheck — nothing was sent to the channel",
        {
          outcome: "blocked",
          error_code: "OUT_OF_STOCK",
          reason: inventory.reason,
          stock: inventory.stock,
          attempt,
          auto_cancelled: wasScheduled,
          scheduled_at: claimed.scheduledAt?.toISOString() ?? null,
          audit_action: wasScheduled ? AUTO_CANCELLED_AUDIT_ACTION : "post_job.blocked",
          alert: "OPERATOR_ATTENTION",
        },
      );
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

    // --- 5b. Which API handles this channel (E6) -----------------------------
    // A platform with no publisher wired is the same kind of problem as a
    // channel that is not configured: a rule stops the job BEFORE any claim of
    // "we tried", and the operator gets a sentence naming the platform.
    const publisher = resolvePublisher(deps, channel);
    if (!publisher) {
      const userMessage = `Hệ thống chưa hỗ trợ đăng lên nền tảng "${channel.platform}" — kiểm tra cấu hình kênh.`;
      const blocked = await block(
        deps,
        claimed,
        "CHANNEL_NOT_CONFIGURED",
        userMessage,
        "PUBLISHER_NOT_WIRED",
      );
      log.error("Publish blocked: no publisher for this platform", {
        outcome: "blocked",
        error_code: "CHANNEL_NOT_CONFIGURED",
        platform: channel.platform,
        attempt,
        alert: "OPERATOR_ATTENTION",
      });
      return result(blocked ?? claimed, "blocked", {
        deferredMs: null,
        errorCode: "CHANNEL_NOT_CONFIGURED",
        userMessage,
      });
    }

    // --- 6a0. Video spec, re-checked before the upload (E5.3) ---------------
    // Same reasoning as the two stock checks: the compose-time verdict can be
    // hours old, the file may have been replaced on Drive, and an over-long clip
    // rejected AFTER a multi-megabyte upload wastes the operator's evening.
    let videoDurationSec: number | null = null;
    if (claimed.format !== "image_post") {
      const gate = await checkVideoBeforeUpload(deps, claimed, log);
      if (gate.ok) videoDurationSec = gate.durationSec;
      if (!gate.ok) {
        const blocked = await block(
          deps,
          claimed,
          gate.errorCode,
          gate.userMessage,
          gate.reason,
        );
        log.warn("Publish blocked by the video spec gate — nothing was uploaded", {
          outcome: "blocked",
          error_code: gate.errorCode,
          reason: gate.reason,
          violations: gate.violations,
          format: claimed.format,
          alert: "OPERATOR_ATTENTION",
        });
        return result(blocked ?? claimed, "blocked", {
          deferredMs: null,
          errorCode: gate.errorCode,
          userMessage: gate.userMessage,
        });
      }
    }

    // --- 6a. What the platform gets: bytes for photos, a URL for a video ----
    // Photos are UPLOADED (multipart `source`). Handing Graph a `url=` made
    // Facebook fetch the file itself and give up around 30s — 4 of 10 photos on
    // a measured real post; the same 10 went through as bytes. A video still
    // travels as a signed URL (Meta/TikTok download it themselves), so that path
    // keeps the re-signing step.
    let media: readonly PublishMediaItem[] = [];
    let videoUrl = "";
    if (claimed.format === "image_post") {
      const items = buildMediaItems(deps, claimed);
      if (!items.ok) {
        const blocked = await block(
          deps,
          claimed,
          "MEDIA_NOT_FOUND",
          items.userMessage,
          items.reason,
        );
        log.error("Publish blocked: a photo of this job has no asset id to read bytes from", {
          outcome: "blocked",
          error_code: "MEDIA_NOT_FOUND",
          reason: items.reason,
          file_name: items.fileName,
          media_count: claimed.media.length,
          attempt,
          alert: "OPERATOR_ATTENTION",
        });
        return result(blocked ?? claimed, "blocked", {
          deferredMs: null,
          errorCode: "MEDIA_NOT_FOUND",
          userMessage: items.userMessage,
        });
      }
      media = items.media;
      log.debug("Photo bytes will be uploaded for this attempt", {
        media_count: media.length,
        attempt,
      });
    } else {
      try {
        const resigned = resignMedia(deps, claimed);
        // One video per post: media[0] is the file, the rest (if any) is a
        // thumbnail choice we do not use yet.
        videoUrl = resigned.media[0]?.url ?? "";
        log.debug("Media URLs re-signed for this attempt", {
          media_count: resigned.media.length,
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
          "Không tạo được liên kết video công khai cho bài này — kiểm tra cấu hình MEDIA_PUBLIC_BASE_URL / khoá ký liên kết.";
        // Blocked, not failed: a retry cannot fix a configuration problem, and
        // the platform was never called.
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
    }

    // --- 6b. Handoff: Facebook holds the post, we do not (E8.6) -------------
    if (plan.action === "hand_off") {
      return await handOffToPlatform(deps, log, claimed, {
        publisher,
        channel,
        media,
        settings,
        attempt,
        leadMs: plan.leadMs,
      });
    }

    // --- 6. Publish ---------------------------------------------------------
    const startedAt = deps.clock.nowMs();
    let published: { postId: string; url: string | null };
    try {
      published =
        claimed.format === "image_post"
          ? await publisher.publishImagePost({
              tenantId,
              channel,
              caption: claimed.captionText,
              media,
              idempotencyKey: postJobDuplicateKey(claimed),
            })
          : await publisher.publishVideoPost({
              tenantId,
              channel,
              caption: claimed.captionText,
              videoUrl,
              // TikTok compares it against the account's own cap (creator_info).
              durationSec: videoDurationSec,
              target:
                VIDEO_FORMAT_TARGETS[claimed.format === "reels" ? "reels" : "video_post"]
                  .publisher,
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
    // A scheduled post that reached this line went out on the NORMAL path after
    // its hour (the handoff window closed before Facebook took it). It is a
    // publish, not a failure — but it is late, and the trail must say so
    // instead of showing an on-time post (business rule 5).
    const lateByMs = plan.action === "publish_now" ? plan.lateByMs : 0;
    const publishedLate = lateByMs > 0 && claimed.scheduledAt instanceof Date;
    const done = await move(
      deps,
      claimed,
      "published",
      {
        reason: publishedLate ? "PUBLISHED_LATE" : "PUBLISHED",
        publishedPostId: published.postId,
        publishedUrl: published.url,
        publishedAt: deps.clock.now(),
      },
      publishedLate ? LATE_PUBLISH_AUDIT_ACTION : undefined,
    );
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
    log[publishedLate ? "warn" : "info"](
      publishedLate ? "Published LATE — the scheduled hour had already passed" : "Published",
      {
        outcome: "published",
        published_post_id: done.publishedPostId,
        published_url: done.publishedUrl,
        attempt,
        attempt_count: done.attemptCount,
        // Includes the upload time now: the worker, not Meta, waits for the bytes.
        duration_ms: deps.clock.nowMs() - startedAt,
        media_count: done.media.length,
        scheduled_at: claimed.scheduledAt?.toISOString() ?? null,
        late_by_ms: lateByMs,
        ...(publishedLate
          ? { audit_action: LATE_PUBLISH_AUDIT_ACTION, alert: "OPERATOR_ATTENTION" }
          : {}),
      },
    );
    return result(done, "published", { deferredMs: null });
  };
}

export type PublishPost = ReturnType<typeof makePublishPost>;

// --- helpers ----------------------------------------------------------------

/**
 * Which publisher handles this channel. Null when the platform has none wired —
 * the caller blocks the job instead of throwing, because "we do not support
 * this platform yet" is a configuration answer, not a failed publish attempt.
 */
function resolvePublisher(
  deps: PublishPostDeps,
  channel: ChannelConfig,
): ChannelPublisher | undefined {
  return (
    deps.publishers?.[channel.platform] ??
    // Pre-E6 wiring: a single publisher always meant Facebook.
    (channel.platform === "facebook" ? deps.publisher : undefined)
  );
}

/** post_job.format -> the two vocabularies that describe the same thing. */
export const VIDEO_FORMAT_TARGETS: Readonly<
  Record<"video_post" | "reels", { spec: SpecVideoTarget; publisher: PublisherVideoTarget }>
> = {
  video_post: { spec: "facebook_video", publisher: "video" },
  reels: { spec: "facebook_reels", publisher: "reels" },
};

type VideoGateOutcome =
  | { ok: true; durationSec: number | null }
  | {
      ok: false;
      errorCode: "VIDEO_SPEC_INVALID" | "VIDEO_PROBE_FAILED";
      reason: string;
      userMessage: string;
      violations: readonly VideoSpecViolation[];
    };

/**
 * Probes the clip and measures it against the target's limits.
 *
 * Three outcomes, deliberately not the same thing:
 *   - a rule is broken            -> blocked VIDEO_SPEC_INVALID, every violation
 *                                    listed (an operator re-exporting a clip
 *                                    wants the whole list, not the first line);
 *   - the file cannot be read     -> blocked VIDEO_PROBE_FAILED, no retry: a
 *                                    corrupt file will not fix itself;
 *   - ffprobe is missing HERE     -> warn and publish. PENDING(video-gate-
 *                                    strictness): the PM decides whether an
 *                                    unchecked video may go out at all; until
 *                                    then a missing binary must not stop the
 *                                    shop from posting.
 */
async function checkVideoBeforeUpload(
  deps: PublishPostDeps,
  job: PostJob,
  log: Logger,
): Promise<VideoGateOutcome> {
  const targets = VIDEO_FORMAT_TARGETS[job.format === "reels" ? "reels" : "video_post"];
  const unchecked = (reason: string, context: Record<string, unknown> = {}): VideoGateOutcome => {
    log.warn("Publishing a video without a fresh specification check", {
      error_code: "VIDEO_PROBE_FAILED",
      reason,
      format: job.format,
      video_target: targets.spec,
      ...context,
    });
    return { ok: true, durationSec: null };
  };

  if (!deps.videoProbe || !deps.mediaAssets) {
    return unchecked("VIDEO_PROBE_NOT_WIRED");
  }

  const item = job.media[0];
  const driveFileId = typeof item?.driveFileId === "string" ? item.driveFileId.trim() : "";
  if (driveFileId.length === 0) {
    // A job created before signed URLs: nothing identifies the asset.
    return unchecked("MEDIA_WITHOUT_ASSET_ID", { file_name: item?.fileName ?? null });
  }

  let asset;
  try {
    asset = await deps.mediaAssets.findByDriveFileId(job.tenantId, driveFileId);
  } catch (error) {
    // The snapshot is unreachable; that is an infrastructure problem, not a bad
    // file. Let the queue retry rather than blocking a valid post.
    throw AppError.from(error, "DB_ERROR", {
      tenant_id: job.tenantId,
      job_id: job.id,
      drive_file_id: driveFileId,
      operation: "publishPost.videoGate.findAsset",
    });
  }
  if (!asset) {
    return {
      ok: false,
      errorCode: "VIDEO_PROBE_FAILED",
      reason: "ASSET_NOT_IN_SNAPSHOT",
      userMessage: `Không tìm thấy video "${item?.fileName ?? driveFileId}" trong dữ liệu đã đồng bộ — không đăng.`,
      violations: [],
    };
  }

  let spec;
  try {
    spec = await deps.videoProbe.probeAsset({ tenantId: job.tenantId, asset });
  } catch (error) {
    const appError = AppError.from(error, "VIDEO_PROBE_FAILED", {
      tenant_id: job.tenantId,
      job_id: job.id,
      drive_file_id: driveFileId,
      video_target: targets.spec,
    });
    const reason = typeof appError.context.reason === "string" ? appError.context.reason : "PROBE_FAILED";
    // Port contract (core/ports/media-probe): this ONE reason means "no ffprobe
    // in this process", not "bad file".
    if (reason === "FFPROBE_NOT_AVAILABLE") {
      return unchecked(reason, { err: appError });
    }
    return {
      ok: false,
      errorCode: "VIDEO_PROBE_FAILED",
      reason,
      userMessage: `Không đọc được thông số video "${asset.fileName}" (${reason}) — không đăng.`,
      violations: [],
    };
  }

  const verdict = evaluateVideoSpec(spec, targets.spec);
  if (!verdict.ok) {
    return {
      ok: false,
      errorCode: "VIDEO_SPEC_INVALID",
      reason: verdict.violations[0]?.rule ?? "VIDEO_SPEC_INVALID",
      // First line for the row, the full list in the log/context.
      userMessage: verdict.violations[0]?.userMessage ?? summarizeViolations(verdict.violations),
      violations: verdict.violations,
    };
  }
  for (const warning of verdict.warnings) {
    log.info("Video spec warning (published anyway)", { warning, video_target: targets.spec });
  }
  return { ok: true, durationSec: spec.durationSec };
}

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
 * Turns the job's media rows into LAZY byte sources for the publisher.
 *
 * Lazy on purpose: an album is up to 10 files of ~9MB, the publisher uploads
 * them one at a time, and the worker runs several jobs at once — reading all ten
 * here would hold ~90MB per job for nothing. `readBytes` of photo k runs
 * immediately before photo k is uploaded.
 *
 * A row without an asset id has nothing to read from, so it is refused HERE,
 * with its file name, instead of becoming an opaque platform error later. Those
 * rows predate signed media URLs and used to be published by their stored URL —
 * the very mechanism this change removes.
 */
function buildMediaItems(
  deps: PublishPostDeps,
  job: PostJob,
):
  | { ok: true; media: readonly PublishMediaItem[] }
  | { ok: false; reason: string; fileName: string | null; userMessage: string } {
  const rows = Array.isArray(job.media) ? job.media : [];
  const media: PublishMediaItem[] = [];

  for (const item of rows) {
    const assetId = typeof item?.driveFileId === "string" ? item.driveFileId.trim() : "";
    const fileName = typeof item?.fileName === "string" ? item.fileName : "";
    if (assetId.length === 0) {
      return {
        ok: false,
        reason: "LEGACY_MEDIA_WITHOUT_ASSET_ID",
        fileName: fileName || null,
        userMessage: `Ảnh "${fileName || "không rõ tên"}" của bài này thiếu mã file — cần tạo lại bài đăng.`,
      };
    }
    media.push({
      driveFileId: assetId,
      fileName,
      // Reads the cache first, then Drive / the blob store (read-media-bytes).
      readBytes: () => deps.readMediaBytes({ tenantId: job.tenantId, assetId, jobId: job.id }),
    });
  }

  return { ok: true, media };
}

/**
 * Puts a still-`queued` job back on the queue with a delay, and points the row
 * at the NEW entry. Used by the spacing gate and by the handoff window — both
 * mean "nothing is wrong, come back later", and both must leave the job exactly
 * where it is (`queued`, unclaimed, nothing sent).
 *
 * Order: point the row at the new entry FIRST, enqueue second. The stale-entry
 * guard in publishPost would otherwise reject the deferred entry and the post
 * would never go out. A failed enqueue rolls the pointer back.
 */
async function deferQueuedJob(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  ctx: {
    delayMs: number;
    reason: string;
    settings: PublishSettings;
    maxAttempts: number;
    attempt: number;
    logMessage: string;
    extraLog?: Record<string, unknown>;
  },
): Promise<PublishPostResult> {
  // A NEW queue id: BullMQ silently drops an `add` whose id is still retained,
  // which would lose this post entirely.
  const deferredQueueJobId = deferredPostJobQueueId(job, deps.clock.nowMs());
  const pointed = await deps.postJobs.setQueueJobId({
    tenantId: job.tenantId,
    postJobId: job.id,
    queueJobId: deferredQueueJobId,
  });
  if (!pointed) {
    log.warn("Publish skipped: the job left `queued` while it was being deferred", {
      outcome: "skipped",
      reason: "ROW_CHANGED_DURING_DEFERRAL",
      defer_reason: ctx.reason,
      attempt: ctx.attempt,
    });
    return result(job, "skipped", { deferredMs: null, skipReason: "ROW_CHANGED_DURING_DEFERRAL" });
  }

  try {
    await deps.queue.enqueue(
      PUBLISH_POST_JOB_NAME,
      { tenantId: job.tenantId, postJobId: job.id },
      {
        jobId: deferredQueueJobId,
        delayMs: ctx.delayMs,
        attempts: ctx.maxAttempts,
        backoff: { strategy: "exponential", delayMs: ctx.settings.retryBackoffMs },
      },
    );
  } catch (error) {
    // Put the pointer back on the entry that is running right now, so the queue
    // retry of THIS message is not rejected as stale. Its own failure is logged,
    // never swallowed: the QUEUE_ERROR below is the cause the caller must see.
    await deps.postJobs
      .setQueueJobId({ tenantId: job.tenantId, postJobId: job.id, queueJobId: job.queueJobId })
      .catch((rollbackError: unknown) => {
        log.error("Could not restore the queue pointer after a failed deferral", {
          err: AppError.from(rollbackError, "DB_ERROR", {
            tenant_id: job.tenantId,
            job_id: job.id,
          }),
          reason: "DEFER_ROLLBACK_FAILED",
          alert: "OPERATOR_ATTENTION",
        });
        return false;
      });
    throw AppError.from(error, "QUEUE_ERROR", {
      tenant_id: job.tenantId,
      job_id: job.id,
      channel: job.channelId,
      operation: "publishPost.defer",
      defer_reason: ctx.reason,
    });
  }

  log.info(ctx.logMessage, {
    outcome: "deferred",
    queue_job_id: deferredQueueJobId,
    wait_ms: ctx.delayMs,
    defer_reason: ctx.reason,
    attempt: ctx.attempt,
    ...(ctx.extraLog ?? {}),
  });
  return result(job, "deferred", { deferredMs: ctx.delayMs });
}

/**
 * E8.6 — hand ONE claimed job to the platform's own scheduler.
 *
 * The job is already `publishing` (claimed), the stock has been re-checked and
 * the channel resolved: everything above this line is identical to an immediate
 * publish, which is the point — the only difference is WHO waits for the hour.
 *
 * Outcomes:
 *   accepted            -> `scheduled_on_facebook` + the remote post id. The
 *                          queue is done with this job; only the reconciliation
 *                          sweep may declare it published.
 *   token dead          -> `blocked`, like the immediate path.
 *   failed BEFORE the
 *   creating request    -> back to `queued`: another attempt inside the window,
 *                          or a wake-up AT the hour that publishes on the normal
 *                          path. Safe only because the platform provably holds
 *                          nothing (port contract: platform_created_nothing).
 *   outcome unknown     -> `failed`. NOT retried and NOT published at the hour:
 *                          the platform may already hold a scheduled post for
 *                          this job, and either move would put two posts on the
 *                          Page at the same minute.
 */
async function handOffToPlatform(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  ctx: {
    publisher: ChannelPublisher;
    channel: ChannelConfig;
    media: readonly PublishMediaItem[];
    settings: PublishSettings;
    attempt: number;
    leadMs: number;
  },
): Promise<PublishPostResult> {
  const scheduledAt = job.scheduledAt;
  const scheduler = ctx.publisher.scheduled;
  if (!(scheduledAt instanceof Date)) {
    // Unreachable through planScheduledPublish, but a handoff without an hour
    // would ask the platform to hold a post forever.
    throw new AppError("INTERNAL", {
      message: "handOffToPlatform called for a job without a scheduled time",
      context: { tenant_id: job.tenantId, job_id: job.id, channel: job.channelId },
    });
  }
  if (!scheduler) {
    // This platform cannot hold a post. Give the job back to the queue and let
    // it publish at the hour, exactly as before E8.6.
    log.warn("Platform has no scheduler — falling back to publishing at the hour", {
      reason: "HANDOFF_NOT_SUPPORTED",
      platform: ctx.channel.platform,
      scheduled_at: scheduledAt.toISOString(),
    });
    return await requeueForLater(deps, log, job, {
      delayMs: Math.max(0, scheduledAt.getTime() - deps.clock.nowMs()),
      reason: "HANDOFF_NOT_SUPPORTED",
      errorCode: null,
      errorMessage: null,
      settings: ctx.settings,
      attempt: ctx.attempt,
    });
  }

  // The window is re-read HERE, not trusted from the top of the run: the stock
  // recheck, the channel read and the media lookup all take time, and a handoff
  // that drifted past T-12 would be refused by Facebook after a full upload.
  const now = planScheduledPublish(scheduledAt, deps.clock.nowMs());
  if (now.action !== "hand_off") {
    const delayMs = now.action === "wait" ? now.wakeInMs : 0;
    log.warn("The handoff window closed while this job was being prepared", {
      reason: "WINDOW_CLOSED_BEFORE_HANDOFF",
      plan: now.action,
      scheduled_at: scheduledAt.toISOString(),
      wake_in_ms: delayMs,
    });
    return await requeueForLater(deps, log, job, {
      delayMs,
      reason: "WINDOW_CLOSED_BEFORE_HANDOFF",
      errorCode: null,
      errorMessage: null,
      settings: ctx.settings,
      attempt: ctx.attempt,
    });
  }

  const startedAt = deps.clock.nowMs();
  let handed: { scheduledPostId: string };
  try {
    handed = await scheduler.schedulePost({
      tenantId: job.tenantId,
      channel: ctx.channel,
      caption: job.captionText,
      media: ctx.media,
      idempotencyKey: postJobDuplicateKey(job),
      publishAt: scheduledAt,
    });
  } catch (error) {
    return await handleHandoffError(deps, log, job, error, {
      attempt: ctx.attempt,
      settings: ctx.settings,
      durationMs: deps.clock.nowMs() - startedAt,
      scheduledAt,
    });
  }

  const scheduledOnPlatform = await move(
    deps,
    job,
    "scheduled_on_facebook",
    { reason: "HANDED_OFF_TO_PLATFORM", scheduledPostId: handed.scheduledPostId },
    HANDED_OFF_AUDIT_ACTION,
    // The default audit payload only carries `published_post_id`, which is null
    // here — so the single most important event of a scheduled post (the moment
    // the object was created on Facebook) would leave no id behind. The cancel
    // and the reconciliation sweep both store it; this must too.
    // `scheduled_at` is NOT repeated here: the repo writes its own and merges
    // this payload UNDER it, so the copy would be silently dropped anyway.
    {
      scheduled_post_id: handed.scheduledPostId,
      lead_ms: ctx.leadMs,
    },
  );
  if (!scheduledOnPlatform) {
    // Facebook HOLDS the post but the row moved under us. Never silent: nothing
    // must republish it, and a human has to reconcile.
    const appError = new AppError("INTERNAL", {
      message: "Post handed to the platform but the job row was no longer in 'publishing'",
      userMessage:
        "Facebook đã nhận lịch đăng nhưng hệ thống không ghi được trạng thái — cần kiểm tra trên Page.",
      context: {
        tenant_id: job.tenantId,
        job_id: job.id,
        channel: job.channelId,
        scheduled_post_id: handed.scheduledPostId,
        scheduled_at: scheduledAt.toISOString(),
      },
    });
    log.error("Handed off but could not store the state", {
      err: appError,
      error_code: "INTERNAL",
      alert: "OPERATOR_ATTENTION",
    });
    throw appError;
  }

  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  log.info("Handed the post to the platform's scheduler", {
    outcome: "scheduled_on_facebook",
    scheduled_post_id: handed.scheduledPostId,
    scheduled_at: scheduledAt.toISOString(),
    lead_ms: ctx.leadMs,
    duration_ms: deps.clock.nowMs() - startedAt,
    media_count: job.media.length,
    attempt: ctx.attempt,
    audit_action: HANDED_OFF_AUDIT_ACTION,
  });
  return result(scheduledOnPlatform, "scheduled_on_facebook", { deferredMs: null });
}

/**
 * A failed handoff. TOKEN_EXPIRED blocks, exactly like handlePublishError.
 *
 * Everything else is decided by ONE question, and deliberately not by
 * `retryable`: does the platform provably hold nothing for this job? Only then
 * may the job move again — another attempt inside the window (transient), or a
 * wake-up AT the hour on the normal publish path (definitive). "Another attempt"
 * means the NEXT slot of the handoff window, not a BullMQ backoff: the window is
 * minutes wide and the queue's backoff knows nothing about the hour.
 *
 * Without that proof the job stops (see failUnconfirmedHandoff).
 */
async function handleHandoffError(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  error: unknown,
  ctx: { attempt: number; settings: PublishSettings; durationMs: number; scheduledAt: Date },
): Promise<PublishPostResult> {
  const appError = AppError.from(error, "META_ERROR", {
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
    attempt: ctx.attempt,
    operation: "publishPost.handOff",
    scheduled_at: ctx.scheduledAt.toISOString(),
  });

  if (appError.code === "TOKEN_EXPIRED") {
    const blocked = await block(deps, job, "TOKEN_EXPIRED", appError.userMessage, "TOKEN_EXPIRED");
    log.error("Handoff blocked: channel token expired or revoked", {
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
      userMessage: appError.userMessage,
    });
  }

  const retryable = (appError.context as { retryable?: unknown }).retryable !== false;
  const flags = appError.context as {
    platform_created_nothing?: unknown;
    feed_dispatched?: unknown;
  };
  // Refused BEFORE anything that could create a post was ever sent (port
  // contract: the publisher's own pre-flight guards and the media upload, which
  // only makes unpublished objects). Facebook answers #100 to a
  // `scheduled_publish_time` under its ~10-minute minimum, and an album upload
  // can easily eat the ~2 minutes between the handoff deadline and that minimum.
  // Failing the job there would drop a post while the safe path — wait for T and
  // publish normally — was still fully available, and cannot double-post because
  // the platform holds nothing.
  const createdNothing = flags.platform_created_nothing === true;

  // ANYTHING ELSE is an unknown outcome — the creating request was dispatched
  // (`feed_dispatched`), or the publisher gave no proof at all. This branch must
  // never lead anywhere near the normal publish path and is never retried: the
  // platform may be holding a scheduled post for this job right now, and the
  // most misleading evidence looks exactly like a refusal (#506 DUPLICATE_POST
  // answered to a retry after a lost answer). A second handoff would ask for a
  // second scheduled post at the same minute; publishing at the hour would put a
  // live post next to the one the platform is holding. Both are business rule 4.
  //
  // Note this ignores `retryable`: it describes whether the PLATFORM CALL could
  // succeed later, not whether repeating it is safe. Only the flag above can say
  // that, and it wins over `retryable` in both directions.
  if (!createdNothing || flags.feed_dispatched === true) {
    return await failUnconfirmedHandoff(deps, log, job, appError, ctx);
  }

  if (!retryable) {
    const delayMs = Math.max(0, ctx.scheduledAt.getTime() - deps.clock.nowMs());
    const userMessage = `Facebook không nhận lịch đăng của bài này (${appError.userMessage}) — chưa có bài nào được tạo trên Trang, hệ thống sẽ đăng thẳng vào giờ đã hẹn.`;
    const requeued = await requeueForLater(deps, log, job, {
      delayMs,
      reason: "HANDOFF_REFUSED_NOTHING_CREATED",
      errorCode: HANDOFF_REFUSED_ERROR_CODE,
      errorMessage: userMessage,
      settings: ctx.settings,
      attempt: ctx.attempt,
    });
    log.error("Facebook refused the schedule but created nothing — publishing at the hour instead", {
      err: appError,
      error_code: HANDOFF_REFUSED_ERROR_CODE,
      original_code: appError.code,
      attempt: ctx.attempt,
      duration_ms: ctx.durationMs,
      publish_in_ms: delayMs,
      scheduled_at: ctx.scheduledAt.toISOString(),
      platform_created_nothing: true,
      alert: "OPERATOR_ATTENTION",
    });
    return requeued;
  }

  // Transient: try again inside the window, or wake up AT the hour and publish
  // on the normal path (late by seconds instead of not at all).
  const delayMs = nextHandoffAttemptDelayMs(ctx.scheduledAt, deps.clock.nowMs());
  // Another handoff only happens if the next wake-up is still before the
  // deadline; otherwise that wake-up lands ON the hour and publishes normally.
  const windowStillOpen =
    deps.clock.nowMs() + delayMs <= ctx.scheduledAt.getTime() - HANDOFF_DEADLINE_MS;
  const userMessage = windowStillOpen
    ? `Chưa giao được lịch cho Facebook (${appError.userMessage}) — hệ thống sẽ thử lại trước giờ đăng.`
    : `Không giao được lịch cho Facebook (${appError.userMessage}) — bài sẽ được đăng thẳng vào giờ đã hẹn.`;
  const requeued = await requeueForLater(deps, log, job, {
    delayMs,
    reason: windowStillOpen ? "HANDOFF_RETRY" : HANDOFF_EXPIRED_ERROR_CODE,
    errorCode: windowStillOpen ? appError.code : HANDOFF_EXPIRED_ERROR_CODE,
    errorMessage: userMessage,
    settings: ctx.settings,
    attempt: ctx.attempt,
  });
  log.error(
    windowStillOpen
      ? "Handoff failed, another attempt fits before the deadline"
      : "Handoff window closed — the post will be published at its hour instead",
    {
      err: appError,
      error_code: appError.code,
      attempt: ctx.attempt,
      duration_ms: ctx.durationMs,
      next_attempt_in_ms: delayMs,
      scheduled_at: ctx.scheduledAt.toISOString(),
      window_still_open: windowStillOpen,
      alert: "OPERATOR_ATTENTION",
    },
  );
  return requeued;
}

/**
 * The handoff ended without a verdict: the request that creates the post on the
 * platform was dispatched (or the publisher could not promise it was not), and
 * nobody knows whether a scheduled post now exists.
 *
 * The job stops here — `failed`, no retry, no publish at the hour — because both
 * ways forward can put a second post on the Page in the same minute:
 *   - another handoff  -> a second scheduled post;
 *   - publishing at T  -> a live post next to the one the platform holds.
 * A post that does not go out is a bad day; two posts on a customer's Page is
 * the failure this whole flow exists to prevent (business rule 4).
 *
 * The Vietnamese message therefore says the ONE thing an operator can act on:
 * look at the Page's scheduled posts before doing anything with this job.
 */
async function failUnconfirmedHandoff(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  appError: AppError,
  ctx: { attempt: number; durationMs: number; scheduledAt: Date },
): Promise<never> {
  const feedDispatched = (appError.context as { feed_dispatched?: unknown }).feed_dispatched === true;
  const userMessage =
    `Không xác nhận được kết quả giao lịch cho Facebook (${appError.userMessage}) — ` +
    "bài hẹn CÓ THỂ đã được tạo trên Trang. Hệ thống dừng lại và KHÔNG tự đăng lại để tránh đăng trùng: " +
    "hãy mở Trang, mục bài đã lên lịch, xoá bài nếu thấy rồi hẹn lại.";

  await move(
    deps,
    job,
    "failed",
    {
      reason: "HANDOFF_OUTCOME_UNKNOWN",
      errorCode: HANDOFF_FAILED_ERROR_CODE,
      errorMessage: userMessage,
    },
    SCHEDULED_FAILED_AUDIT_ACTION,
  );
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  log.error("Handoff outcome unknown — job stopped so nothing can double-post", {
    err: appError,
    outcome: "failed",
    error_code: HANDOFF_FAILED_ERROR_CODE,
    original_code: appError.code,
    // The two facts that answer "vì sao bài này không lên" without a debugger.
    feed_dispatched: feedDispatched,
    platform_created_nothing: false,
    attempt: ctx.attempt,
    duration_ms: ctx.durationMs,
    scheduled_at: ctx.scheduledAt.toISOString(),
    audit_action: SCHEDULED_FAILED_AUDIT_ACTION,
    alert: "OPERATOR_ATTENTION",
  });
  // Rethrown so the queue records a failure; the row already carries the why.
  throw appError;
}

/**
 * Gives a CLAIMED job back to the queue for a later run: `publishing -> queued`
 * with a new entry id, then the enqueue.
 *
 * If the enqueue fails the row stays `queued` with an id nothing answers to —
 * which is exactly the case the reaper detects (`queue.has` false) and fixes on
 * its next sweep, so the post is not lost.
 */
async function requeueForLater(
  deps: PublishPostDeps,
  log: Logger,
  job: PostJob,
  ctx: {
    delayMs: number;
    reason: string;
    errorCode: string | null;
    errorMessage: string | null;
    settings: PublishSettings;
    attempt: number;
  },
): Promise<PublishPostResult> {
  const queueJobId = deferredPostJobQueueId(job, deps.clock.nowMs());
  const requeued = await move(deps, job, "queued", {
    reason: ctx.reason,
    errorCode: ctx.errorCode,
    errorMessage: ctx.errorMessage,
    queueJobId,
  });
  if (!requeued) {
    log.warn("Could not give the job back to the queue: the row changed under us", {
      outcome: "skipped",
      reason: "ROW_CHANGED_DURING_REQUEUE",
      requeue_reason: ctx.reason,
    });
    return result(job, "skipped", { deferredMs: null, skipReason: "ROW_CHANGED_DURING_REQUEUE" });
  }

  try {
    await deps.queue.enqueue(
      PUBLISH_POST_JOB_NAME,
      { tenantId: job.tenantId, postJobId: job.id },
      {
        jobId: queueJobId,
        delayMs: ctx.delayMs,
        attempts: ctx.settings.maxAttempts,
        backoff: { strategy: "exponential", delayMs: ctx.settings.retryBackoffMs },
      },
    );
  } catch (error) {
    // The row is `queued` with a queue id that does not exist. Loud, not silent:
    // the reaper re-enqueues it, but an operator must see that it happened.
    const appError = AppError.from(error, "QUEUE_ERROR", {
      tenant_id: job.tenantId,
      job_id: job.id,
      channel: job.channelId,
      operation: "publishPost.requeueForLater",
      requeue_reason: ctx.reason,
    });
    log.error("Job returned to `queued` but the new queue entry could not be created", {
      err: appError,
      error_code: appError.code,
      queue_job_id: queueJobId,
      alert: "OPERATOR_ATTENTION",
    });
    throw appError;
  }

  log.info("Job returned to the queue for a later run", {
    outcome: "deferred",
    queue_job_id: queueJobId,
    wait_ms: ctx.delayMs,
    requeue_reason: ctx.reason,
    attempt: ctx.attempt,
  });
  return result(requeued, "deferred", {
    deferredMs: ctx.delayMs,
    errorCode: ctx.errorCode,
    userMessage: ctx.errorMessage,
  });
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
  // E8.5 — "đến giờ mà đăng lỗi thì phải báo": a scheduled post that fails is
  // its own audit event, because nobody is watching the screen at that hour.
  const wasScheduled = job.scheduledAt instanceof Date;
  await move(
    deps,
    job,
    "failed",
    {
      reason: retryable ? "RETRIES_EXHAUSTED" : "NON_RETRYABLE_PLATFORM_ERROR",
      errorCode: "PUBLISH_FAILED",
      errorMessage: `${finalError.userMessage} (${appError.userMessage})`,
    },
    wasScheduled ? SCHEDULED_FAILED_AUDIT_ACTION : undefined,
  );
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  log.error(
    wasScheduled ? "Scheduled publish failed permanently" : "Publish failed permanently",
    {
      err: finalError,
      error_code: "PUBLISH_FAILED",
      original_code: appError.code,
      attempt: ctx.attempt,
      max_attempts: ctx.maxAttempts,
      duration_ms: ctx.durationMs,
      will_retry: false,
      retryable_platform_error: retryable,
      scheduled_at: job.scheduledAt?.toISOString() ?? null,
      audit_action: wasScheduled ? SCHEDULED_FAILED_AUDIT_ACTION : "post_job.failed",
      alert: "OPERATOR_ATTENTION",
    },
  );
  throw finalError;
}

/** Domain transition + optimistic DB write. Null = another writer won. */
async function move(
  deps: PublishPostDeps,
  job: PostJob,
  to: PostJobStatus,
  meta: TransitionMeta & { reason: string },
  auditAction?: string,
  auditPayload?: Readonly<Record<string, unknown>>,
): Promise<PostJob | null> {
  const next = transitionPostJob(job, to, meta);
  return deps.postJobs.applyTransition({
    tenantId: job.tenantId,
    postJobId: job.id,
    from: job.status,
    next,
    reason: meta.reason,
    ...(auditAction ? { auditAction } : {}),
    ...(auditPayload ? { auditPayload } : {}),
  });
}

async function block(
  deps: PublishPostDeps,
  job: PostJob,
  errorCode: string,
  userMessage: string,
  reason: string,
  auditAction?: string,
): Promise<PostJob | null> {
  const blocked = await move(
    deps,
    job,
    "blocked",
    { reason, errorCode, errorMessage: userMessage },
    auditAction,
  );
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId);
  return blocked;
}

function result(
  job: PostJob,
  outcome: PublishPostOutcome,
  extra: {
    deferredMs: number | null;
    errorCode?: string | null;
    userMessage?: string | null;
    skipReason?: string | null;
  },
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
    scheduledPostId: job.scheduledPostId,
    errorCode: extra.errorCode ?? job.lastErrorCode,
    userMessage: extra.userMessage ?? job.lastErrorMessage,
    deferredMs: extra.deferredMs,
    skipReason: extra.skipReason ?? null,
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

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
