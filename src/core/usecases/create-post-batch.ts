import { AppError } from "@/core/domain/errors";
import { evaluateProductInventory } from "@/core/domain/inventory";
import { normalizeColorName } from "@/core/domain/media-file-name";
import {
  MAX_ALBUM_MEDIA,
  PHASE_1_FORMATS,
  isPostFormat,
  postJobDuplicateKey,
  postJobQueueId,
  transitionPostJob,
  type PostBatchStatus,
  type PostFormat,
  type PostJob,
  type PostJobMedia,
  type PostJobStatus,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { NewPostJob, PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";

import { PUBLISH_POST_JOB_NAME } from "./publish-post";

/**
 * E7.2 — fan out ONE post to N channels: one post_job per channel, independent
 * from the first line (business rule 6). A channel that is not configured is
 * blocked on its own row; the other channels keep going.
 *
 * Order (business rule 1): stock gate BEFORE anything is queued. A sold-out code
 * still gets its batch + jobs, all `blocked`, so the operator sees WHY in the
 * batch summary instead of a silent no-op.
 *
 * The anti-duplicate lock (rule 4) is the unique index on
 * (tenant, batch, code, colour, channel, format), taken inside the creating
 * transaction — i.e. before any publish call exists. Re-running this usecase
 * with the same `batchId` (the idempotency scope: a retried request, a replayed
 * job) hits it and raises DUPLICATE_POST_BLOCKED.
 */

export interface CreatePostBatchInput {
  readonly tenantId: string;
  /**
   * Idempotency scope. Pass the SAME id to retry a half-created batch safely;
   * omit it for a brand new batch (a fresh id is generated).
   */
  readonly batchId?: string;
  readonly productCode: string;
  /** Canonical or free-form colour; "" / absent = every colour of the code. */
  readonly color?: string;
  readonly format?: PostFormat;
  readonly channelIds: readonly string[];
  /** One caption per channel (brief §7.2 — never share a caption). */
  readonly captionByChannel: Readonly<Record<string, string>>;
  readonly media: readonly PostJobMedia[];
  /** Phase 2 scheduling; a future date simply delays the queue job. */
  readonly scheduledAt?: Date | null;
  readonly createdBy?: string | null;
  readonly note?: string | null;
}

export interface CreatePostBatchChannelResult {
  readonly channelId: string;
  readonly postJobId: string;
  readonly status: PostJobStatus;
  readonly queued: boolean;
  readonly queueJobId: string | null;
  readonly errorCode: string | null;
  readonly userMessage: string | null;
}

export interface CreatePostBatchResult {
  readonly tenantId: string;
  readonly batchId: string;
  readonly productCode: string;
  readonly color: string;
  readonly format: PostFormat;
  readonly batchStatus: PostBatchStatus;
  readonly channels: readonly CreatePostBatchChannelResult[];
  /** Internal operator notes (low stock...). Never part of a caption. */
  readonly warnings: readonly string[];
}

export interface CreatePostBatchDeps {
  postJobs: PostJobRepo;
  products: ProductRepo;
  channels: ChannelConfigRepo;
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  /** Injected so tests get deterministic ids. */
  newId: () => string;
}

export function makeCreatePostBatch(deps: CreatePostBatchDeps) {
  return async function createPostBatch(
    input: CreatePostBatchInput,
  ): Promise<CreatePostBatchResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const tenantId = str(input?.tenantId);
    const productCode = str(input?.productCode).toUpperCase();
    if (!isTenantId(tenantId) || productCode.length === 0) {
      throw invalid("createPostBatch requires a tenant UUID and a product code", {
        tenant_id: tenantId || null,
        product_code: productCode || null,
      });
    }

    const format = input?.format ?? "image_post";
    if (!isPostFormat(format) || !PHASE_1_FORMATS.includes(format)) {
      throw invalid(`Format "${String(format)}" is not available in Phase 1`, {
        tenant_id: tenantId,
        product_code: productCode,
        format,
        supported: PHASE_1_FORMATS,
      });
    }

    const channelIds = uniqueStrings(input?.channelIds);
    if (channelIds.length === 0) {
      throw invalid("createPostBatch requires at least one channel", {
        tenant_id: tenantId,
        product_code: productCode,
      });
    }

    const media = normaliseMedia(input?.media);
    if (media instanceof AppError) throw media;

    const captions = new Map<string, string>();
    const missingCaptions: string[] = [];
    for (const channelId of channelIds) {
      const caption = str(input?.captionByChannel?.[channelId]);
      if (caption.length === 0) missingCaptions.push(channelId);
      else captions.set(channelId, caption);
    }
    if (missingCaptions.length > 0) {
      // A caption per channel is a hard requirement (brief §7.2); a missing one
      // is a caller bug, not a per-channel runtime failure.
      throw invalid(`Missing caption for channel(s): ${missingCaptions.join(", ")}`, {
        tenant_id: tenantId,
        product_code: productCode,
        channels_without_caption: missingCaptions,
      });
    }

    const batchId = str(input?.batchId) || deps.newId();
    const color = normaliseColor(input?.color);
    const log = deps.logger.child({
      tenant_id: tenantId,
      batch_id: batchId,
      product_code: productCode,
    });

    const duplicateCaption = findSharedCaption(captions);
    if (duplicateCaption) {
      // Not fatal here (E4 owns caption rules) but it must be visible.
      log.warn("Two channels received an identical caption (brief §7.2 requires distinct ones)", {
        channels: duplicateCaption,
      });
    }

    // --- Stock gate BEFORE queueing anything (business rule 1) -------------
    const product = await deps.products.findByCode(tenantId, productCode);
    if (!product) {
      throw new AppError("PRODUCT_NOT_FOUND", {
        message: `Product ${productCode} is not in the sheet snapshot`,
        userMessage: `Không tìm thấy mã ${productCode} trên Sheet — chưa đăng được`,
        context: { tenant_id: tenantId, product_code: productCode, batch_id: batchId },
      });
    }
    const inventory = evaluateProductInventory(product);
    const warnings: string[] = [];
    if (inventory.operatorMessage) warnings.push(inventory.operatorMessage);

    // --- Create batch + jobs in ONE transaction (the lock) ------------------
    const newJobs: NewPostJob[] = channelIds.map((channelId) => ({
      id: deps.newId(),
      tenantId,
      batchId,
      productCode,
      color,
      channelId,
      format,
      captionText: captions.get(channelId) ?? "",
      media,
      scheduledAt: input?.scheduledAt ?? null,
    }));

    const created = await deps.postJobs.createBatchWithJobs({
      batch: {
        id: batchId,
        tenantId,
        productCode,
        color,
        format,
        note: str(input?.note) || null,
        createdBy: str(input?.createdBy) || null,
      },
      jobs: newJobs,
    });

    log.info("Post batch created", {
      channels: channelIds,
      job_count: created.jobs.length,
      media_count: media.length,
      stock: inventory.stock,
      inventory_status: inventory.status,
      duplicate_keys: created.jobs.map((job) => postJobDuplicateKey(job)),
    });

    if (inventory.blocked) {
      const userMessage =
        inventory.operatorMessage ?? `Mã ${productCode} đã hết hàng — không đăng`;
      const channels: CreatePostBatchChannelResult[] = [];
      for (const job of created.jobs) {
        const blocked = await moveJob(deps, job, "blocked", {
          reason: inventory.reason ?? "BLOCKED",
          errorCode: "OUT_OF_STOCK",
          errorMessage: userMessage,
        });
        channels.push({
          channelId: job.channelId,
          postJobId: job.id,
          status: blocked?.status ?? "blocked",
          queued: false,
          queueJobId: null,
          errorCode: "OUT_OF_STOCK",
          userMessage,
        });
      }
      const summary = await deps.postJobs.refreshBatchStatus(tenantId, batchId);
      // PENDING(E3): alert channel undecided — log + DB row for now.
      log.warn("Post batch blocked by the stock gate — nothing was queued", {
        error_code: "OUT_OF_STOCK",
        reason: inventory.reason,
        stock: inventory.stock,
        alert: "OPERATOR_ATTENTION",
      });
      return {
        tenantId,
        batchId,
        productCode,
        color,
        format,
        batchStatus: summary.status,
        channels,
        warnings,
      };
    }

    // --- Fan out: one queue job per channel, failures isolated (rule 6) -----
    const settings = await deps.channels.getPublishSettings(tenantId);
    const scheduledDelayMs = scheduleDelayMs(input?.scheduledAt, deps.clock.nowMs());
    const channels: CreatePostBatchChannelResult[] = [];

    for (const job of created.jobs) {
      const jobLog = log.child({ job_id: job.id, channel: job.channelId });

      const channel = await deps.channels.findChannel(tenantId, job.channelId);
      if (!channel || channel.status !== "active") {
        const userMessage = `Kênh "${job.channelId}" chưa được cấu hình hoặc đang tắt — bài này không đăng`;
        const blocked = await moveJob(deps, job, "blocked", {
          reason: channel ? "CHANNEL_DISABLED" : "CHANNEL_MISSING",
          errorCode: "CHANNEL_NOT_CONFIGURED",
          errorMessage: userMessage,
        });
        jobLog.warn("Channel blocked at fan-out; other channels continue", {
          error_code: "CHANNEL_NOT_CONFIGURED",
          channel_status: channel?.status ?? "missing",
        });
        channels.push({
          channelId: job.channelId,
          postJobId: job.id,
          status: blocked?.status ?? "blocked",
          queued: false,
          queueJobId: null,
          errorCode: "CHANNEL_NOT_CONFIGURED",
          userMessage,
        });
        continue;
      }

      // DB first, queue second: a worker must never find the row still `draft`.
      const queuedJob = await moveJob(deps, job, "queued", { reason: "ENQUEUEING" });
      if (!queuedJob) {
        // Another writer moved the row — do not enqueue on top of it.
        jobLog.warn("Skipped enqueue: the job row changed under us", {
          error_code: "INVALID_JOB_TRANSITION",
        });
        channels.push({
          channelId: job.channelId,
          postJobId: job.id,
          status: job.status,
          queued: false,
          queueJobId: null,
          errorCode: "INVALID_JOB_TRANSITION",
          userMessage: "Bài này đang được xử lý ở nơi khác — không đưa vào hàng đợi lần nữa",
        });
        continue;
      }

      const queueJobId = postJobQueueId(queuedJob);
      try {
        await deps.queue.enqueue(
          PUBLISH_POST_JOB_NAME,
          { tenantId, postJobId: queuedJob.id },
          {
            jobId: queueJobId,
            attempts: settings.maxAttempts,
            backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
            ...(scheduledDelayMs > 0 ? { delayMs: scheduledDelayMs } : {}),
          },
        );
      } catch (error) {
        // The queue is down for THIS job only: mark it and keep the loop going.
        const appError = AppError.from(error, "QUEUE_ERROR", {
          tenant_id: tenantId,
          batch_id: batchId,
          job_id: queuedJob.id,
          channel: queuedJob.channelId,
        });
        const userMessage = "Không đưa được bài vào hàng đợi — cần thử lại kênh này";
        await moveJob(deps, queuedJob, "failed", {
          reason: "ENQUEUE_FAILED",
          errorCode: appError.code,
          errorMessage: userMessage,
        });
        jobLog.error("Enqueue failed; the other channels are unaffected", {
          err: appError,
          error_code: appError.code,
        });
        channels.push({
          channelId: job.channelId,
          postJobId: job.id,
          status: "failed",
          queued: false,
          queueJobId: null,
          errorCode: appError.code,
          userMessage,
        });
        continue;
      }

      jobLog.info("Post job queued", {
        queue_job_id: queueJobId,
        delay_ms: scheduledDelayMs,
        attempts: settings.maxAttempts,
      });
      channels.push({
        channelId: job.channelId,
        postJobId: job.id,
        status: "queued",
        queued: true,
        queueJobId,
        errorCode: null,
        userMessage: null,
      });
    }

    const summary = await deps.postJobs.refreshBatchStatus(tenantId, batchId);
    return {
      tenantId,
      batchId,
      productCode,
      color,
      format,
      batchStatus: summary.status,
      channels,
      warnings,
    };
  };
}

export type CreatePostBatch = ReturnType<typeof makeCreatePostBatch>;

// --- helpers ----------------------------------------------------------------

async function moveJob(
  deps: CreatePostBatchDeps,
  job: PostJob,
  to: PostJobStatus,
  meta: { reason: string; errorCode?: string; errorMessage?: string },
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

function invalid(message: string, context: Record<string, unknown>): AppError {
  return new AppError("INVALID_INPUT", {
    message,
    userMessage: "Yêu cầu tạo bài đăng không hợp lệ — vui lòng kiểm tra lại.",
    context,
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen: string[] = [];
  for (const value of values) {
    const trimmed = str(value);
    if (trimmed.length > 0 && !seen.includes(trimmed)) seen.push(trimmed);
  }
  return seen;
}

/** "" = every colour. Canonical form keeps the unique key stable across spellings. */
function normaliseColor(raw: unknown): string {
  const value = str(raw);
  if (value.length === 0) return "";
  return normalizeColorName(value) ?? value.toUpperCase();
}

function normaliseMedia(media: readonly PostJobMedia[] | undefined): PostJobMedia[] | AppError {
  if (!Array.isArray(media) || media.length === 0) {
    return invalid("createPostBatch requires at least one media item", { media_count: 0 });
  }
  if (media.length > MAX_ALBUM_MEDIA) {
    return invalid(`An album takes at most ${MAX_ALBUM_MEDIA} items`, {
      media_count: media.length,
      max: MAX_ALBUM_MEDIA,
    });
  }
  const result: PostJobMedia[] = [];
  for (const [index, item] of media.entries()) {
    const url = str(item?.url);
    // The platform fetches this URL itself: a non-HTTP(S) value fails at the
    // API call, i.e. after the job is queued. Reject it here instead.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return invalid(`Media #${index + 1} has no usable public URL`, {
        media_index: index,
        file_name: str(item?.fileName) || null,
        url: url || null,
      });
    }
    result.push({
      driveFileId: str(item?.driveFileId),
      fileName: str(item?.fileName),
      url,
    });
  }
  return result;
}

/** Two channels sharing one caption — returns the offending channel pair. */
function findSharedCaption(captions: ReadonlyMap<string, string>): string[] | null {
  const seen = new Map<string, string>();
  for (const [channelId, caption] of captions) {
    const key = caption.trim().toLowerCase();
    const other = seen.get(key);
    if (other) return [other, channelId];
    seen.set(key, channelId);
  }
  return null;
}

function scheduleDelayMs(scheduledAt: Date | null | undefined, nowMs: number): number {
  if (!scheduledAt || !(scheduledAt instanceof Date)) return 0;
  const at = scheduledAt.getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - nowMs);
}
