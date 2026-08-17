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

/**
 * Audit actions that name the EVENT, not just the resulting status (E8.3/E8.5).
 * Kept here because the usecase decides when a block is an auto-cancellation.
 */
export const AUTO_CANCELLED_AUDIT_ACTION = "post_job.auto_cancelled";
export const SCHEDULED_FAILED_AUDIT_ACTION = "post_job.scheduled_publish_failed";

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

    // --- 2. Spacing gate (brief §6, PENDING(E1): per channel) ----------------
    const lastPublishedAt = await deps.postJobs.findLastPublishedAt(tenantId, job.channelId);
    const waitMs = spacingWaitMs(lastPublishedAt, deps.clock.nowMs(), settings.spacingMs);
    if (waitMs > 0) {
      // A NEW queue id: BullMQ silently drops an `add` whose id is still
      // retained, which would lose this post entirely.
      const deferredQueueJobId = deferredPostJobQueueId(job, deps.clock.nowMs());
      // The row must point at the entry that will actually run, or the guard
      // above would treat the deferred entry as stale and the post would never
      // go out. Written BEFORE the enqueue, rolled back if the enqueue fails.
      const pointed = await deps.postJobs.setQueueJobId({
        tenantId,
        postJobId: job.id,
        queueJobId: deferredQueueJobId,
      });
      if (!pointed) {
        log.warn("Publish skipped: the job left `queued` while the spacing gate ran", {
          outcome: "skipped",
          reason: "ROW_CHANGED_DURING_DEFERRAL",
          attempt,
        });
        return result(job, "skipped", { deferredMs: null, skipReason: "ROW_CHANGED_DURING_DEFERRAL" });
      }
      try {
        await deps.queue.enqueue(
          PUBLISH_POST_JOB_NAME,
          { tenantId, postJobId: job.id },
          {
            jobId: deferredQueueJobId,
            delayMs: waitMs,
            attempts: maxAttempts,
            backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
          },
        );
      } catch (error) {
        // Put the pointer back on the entry that is running right now, so the
        // queue retry of THIS message is not rejected as stale.
        await deps.postJobs
          .setQueueJobId({ tenantId, postJobId: job.id, queueJobId: job.queueJobId })
          .catch(() => false);
        throw AppError.from(error, "QUEUE_ERROR", {
          tenant_id: tenantId,
          job_id: job.id,
          channel: job.channelId,
          operation: "publishPost.deferForSpacing",
        });
      }
      log.info("Publish deferred by the spacing gate", {
        outcome: "deferred",
        queue_job_id: deferredQueueJobId,
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
      // Includes the upload time now: the worker, not Meta, waits for the bytes.
      duration_ms: deps.clock.nowMs() - startedAt,
      media_count: done.media.length,
    });
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
): Promise<PostJob | null> {
  const next = transitionPostJob(job, to, meta);
  return deps.postJobs.applyTransition({
    tenantId: job.tenantId,
    postJobId: job.id,
    from: job.status,
    next,
    reason: meta.reason,
    ...(auditAction ? { auditAction } : {}),
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
