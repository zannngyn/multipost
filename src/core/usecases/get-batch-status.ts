import { AppError } from "@/core/domain/errors";
import {
  postJobOperatorMessage,
  type PostBatchStatus,
  type PostFormat,
  type PostJobStatus,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { PostJobRepo } from "@/core/ports/post-job-repo";

/**
 * E7.5 — the end-of-run table of brief §3 + §6: one line per channel plus the
 * batch totals. READ ONLY: it never transitions a job and never calls a channel,
 * so an operator can refresh it as often as they like.
 *
 * Every line carries a Vietnamese `userMessage`, because the whole point of this
 * screen is answering "vì sao bài này không lên?" without opening a log file.
 * The message comes from the job row (written by whoever blocked/failed it), so
 * the API, the UI and the smoke script all say exactly the same thing.
 */

export interface BatchChannelStatus {
  readonly channelId: string;
  readonly postJobId: string;
  readonly status: PostJobStatus;
  readonly attemptCount: number;
  readonly publishedPostId: string | null;
  /** Link to the live post — the operator's proof (brief §6). */
  readonly publishedUrl: string | null;
  readonly publishedAt: Date | null;
  readonly lastErrorCode: string | null;
  /** Vietnamese, always present, for every status (not only failures). */
  readonly userMessage: string;
}

export interface BatchTotals {
  readonly total: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
  readonly queued: number;
  readonly publishing: number;
  /** E8.6 — handed to Facebook, waiting for its hour. Nothing is live yet. */
  readonly scheduledOnFacebook: number;
  readonly draft: number;
  /** draft + queued + publishing + scheduled_on_facebook — "còn đang chạy". */
  readonly inProgress: number;
}

export interface GetBatchStatusInput {
  readonly tenantId: string;
  readonly batchId: string;
}

export interface GetBatchStatusResult {
  readonly tenantId: string;
  readonly batchId: string;
  readonly productCode: string;
  readonly color: string;
  readonly format: PostFormat;
  readonly status: PostBatchStatus;
  readonly totals: BatchTotals;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly durationMs: number | null;
  readonly channels: readonly BatchChannelStatus[];
  /** One Vietnamese line summarising the run, for the top of the table. */
  readonly summaryMessage: string;
}

export interface GetBatchStatusDeps {
  postJobs: PostJobRepo;
  logger: Logger;
}

export function makeGetBatchStatus(deps: GetBatchStatusDeps) {
  return async function getBatchStatus(
    input: GetBatchStatusInput,
  ): Promise<GetBatchStatusResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = str(input?.tenantId);
    const batchId = str(input?.batchId);
    if (!isTenantId(tenantId) || batchId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "getBatchStatus requires a tenant UUID and a batch id",
        userMessage: "Yêu cầu xem kết quả lô bài đăng thiếu thông tin định danh.",
        context: { tenant_id: tenantId || null, batch_id: batchId || null },
      });
    }

    const summary = await deps.postJobs.getBatchSummary(tenantId, batchId);
    if (!summary) {
      // Also the "batch of another tenant" case: the repo is tenant-scoped, so a
      // foreign batch simply has no rows here — one code, no information leak
      // about whether it exists elsewhere.
      // NOTE(orchestrator): a dedicated BATCH_NOT_FOUND code would map to 404
      // more honestly; INVALID_INPUT + reason is the closest existing code.
      throw new AppError("INVALID_INPUT", {
        message: "Post batch not found for this tenant",
        userMessage: "Không tìm thấy lô bài đăng này.",
        context: { tenant_id: tenantId, batch_id: batchId, reason: "BATCH_NOT_FOUND" },
      });
    }

    const totals: BatchTotals = {
      total: summary.total,
      published: summary.byStatus.published,
      failed: summary.byStatus.failed,
      blocked: summary.byStatus.blocked,
      queued: summary.byStatus.queued,
      publishing: summary.byStatus.publishing,
      scheduledOnFacebook: summary.byStatus.scheduled_on_facebook,
      draft: summary.byStatus.draft,
      inProgress:
        summary.byStatus.draft +
        summary.byStatus.queued +
        summary.byStatus.publishing +
        // Waiting on Facebook is still "running": the post is not live.
        summary.byStatus.scheduled_on_facebook,
    };

    const channels: BatchChannelStatus[] = summary.jobs.map((job) => ({
      channelId: job.channelId,
      postJobId: job.id,
      status: job.status,
      attemptCount: job.attemptCount,
      publishedPostId: job.publishedPostId,
      publishedUrl: job.publishedUrl,
      publishedAt: job.publishedAt,
      lastErrorCode: job.lastErrorCode,
      userMessage: postJobOperatorMessage(job),
    }));

    const first = summary.jobs[0];
    const result: GetBatchStatusResult = {
      tenantId,
      batchId: summary.batchId,
      productCode: summary.productCode,
      color: first?.color ?? "",
      format: first?.format ?? "image_post",
      status: summary.status,
      totals,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      durationMs: summary.finishedAt
        ? summary.finishedAt.getTime() - summary.startedAt.getTime()
        : null,
      channels,
      summaryMessage: summaryMessage(summary.status, totals),
    };

    deps.logger.info("Batch status read", {
      tenant_id: tenantId,
      batch_id: summary.batchId,
      product_code: summary.productCode,
      batch_status: summary.status,
      totals,
      // Enough to answer "why is this post not live?" straight from the log.
      channels: channels.map((channel) => ({
        channel: channel.channelId,
        status: channel.status,
        attempts: channel.attemptCount,
        error_code: channel.lastErrorCode,
        published_post_id: channel.publishedPostId,
      })),
    });

    return result;
  };
}

export type GetBatchStatus = ReturnType<typeof makeGetBatchStatus>;

// --- helpers ----------------------------------------------------------------

/** Vietnamese headline. `blocked` is deliberately NOT worded as a failure. */
function summaryMessage(status: PostBatchStatus, totals: BatchTotals): string {
  switch (status) {
    case "pending":
      return `Lô có ${totals.total} bài, chưa bài nào được đưa vào hàng đợi`;
    case "running":
      return `Đang chạy: ${totals.published}/${totals.total} bài đã lên, còn ${totals.inProgress} bài đang xử lý`;
    case "completed":
      return `Hoàn tất: cả ${totals.total} bài đã lên kênh`;
    case "partial":
      return `Lên một phần: ${totals.published}/${totals.total} bài đã lên, ${totals.blocked} bài bị chặn, ${totals.failed} bài lỗi`;
    case "blocked":
      return `Không bài nào được gửi đi: cả ${totals.blocked} bài đều bị chặn trước khi đăng (xem lý do từng kênh)`;
    case "failed":
      return `Không bài nào lên được: ${totals.failed} bài lỗi, ${totals.blocked} bài bị chặn`;
    default:
      return `Trạng thái lô không xác định (${totals.total} bài)`;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
