import { AppError } from "@/core/domain/errors";
import {
  canOperatorRetryPostJob,
  isPostJobStatus,
  postJobOperatorMessage,
  postJobProductOrigin,
  type PostFormat,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type { ProductOrigin } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { PostJobCursor, PostJobRepo } from "@/core/ports/post-job-repo";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E11.1 data layer — the job log: every post_job of a tenant, newest first, with
 * the same Vietnamese explanation the batch summary shows. READ ONLY.
 *
 * Keyset pagination, not OFFSET: the list is written to while an operator reads
 * it (a worker publishes, a retry re-queues), and OFFSET would silently skip or
 * repeat rows exactly when something is going wrong — the worst moment to lie.
 *
 * The cursor is a string the caller passes back verbatim. Its format lives here
 * (core), never in the adapter or the UI: `<createdAt ISO>_<post job id>`.
 */

export const DEFAULT_POST_JOB_PAGE_SIZE = 20;
export const MAX_POST_JOB_PAGE_SIZE = 100;

export interface ListPostJobsFilter {
  readonly batchId?: string;
  readonly status?: string;
  readonly channelId?: string;
  readonly productCode?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ListPostJobsInput {
  readonly tenantId: TenantId;
  readonly filter?: ListPostJobsFilter;
}

export interface PostJobLogEntry {
  readonly postJobId: string;
  readonly batchId: string;
  readonly productCode: string;
  /**
   * Where this post's product text came from, stamped at creation. Read from
   * the job row itself, never joined from `product`: months later that row may
   * be gone, and this log is exactly where "bài này lấy dữ liệu từ đâu" gets
   * asked.
   */
  readonly productOrigin: ProductOrigin;
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
  readonly status: PostJobStatus;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  /** Vietnamese "vì sao bài này không lên" — present for every status. */
  readonly userMessage: string;
  readonly publishedPostId: string | null;
  readonly publishedUrl: string | null;
  readonly publishedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * True when an operator may press "chạy lại": `failed`/`blocked`, EXCEPT a
   * job whose handoff outcome is unknown (see canOperatorRetryPostJob).
   */
  readonly canRetry: boolean;
}

export interface ListPostJobsResult {
  readonly tenantId: TenantId;
  readonly items: readonly PostJobLogEntry[];
  /** Pass back as `filter.cursor` for the next page; null = end of the list. */
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface ListPostJobsDeps {
  postJobs: PostJobRepo;
  logger: Logger;
}

export function makeListPostJobs(deps: ListPostJobsDeps) {
  return async function listPostJobs(input: ListPostJobsInput): Promise<ListPostJobsResult> {
    // --- Edge cases first ---------------------------------------------------
    const rawTenantId = str(input?.tenantId);
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "listPostJobs requires a tenant UUID",
        userMessage: "Yêu cầu xem nhật ký đăng bài thiếu mã đơn vị.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const filter = input?.filter ?? {};
    const limit = normaliseLimit(filter.limit);

    const rawStatus = str(filter.status);
    if (rawStatus.length > 0 && !isPostJobStatus(rawStatus)) {
      // An unknown status must not quietly return "everything": the operator
      // would read a filtered screen as an unfiltered one.
      throw new AppError("INVALID_INPUT", {
        message: `Unknown post job status "${rawStatus}"`,
        userMessage: `Trạng thái "${rawStatus}" không hợp lệ.`,
        context: { tenant_id: tenantId, field: "status", value: rawStatus },
      });
    }

    const cursor = decodePostJobCursor(filter.cursor, { tenant_id: tenantId });

    const page = await deps.postJobs.listJobs({
      tenantId,
      batchId: str(filter.batchId) || undefined,
      status: rawStatus.length > 0 ? (rawStatus as PostJobStatus) : undefined,
      channelId: str(filter.channelId) || undefined,
      productCode: str(filter.productCode).toUpperCase() || undefined,
      limit,
      cursor: cursor ?? undefined,
    });

    const items: PostJobLogEntry[] = page.items.map((job) => ({
      postJobId: job.id,
      batchId: job.batchId,
      productCode: job.productCode,
      productOrigin: postJobProductOrigin(job),
      color: job.color,
      channelId: job.channelId,
      format: job.format,
      status: job.status,
      attemptCount: job.attemptCount,
      lastErrorCode: job.lastErrorCode,
      userMessage: postJobOperatorMessage(job),
      publishedPostId: job.publishedPostId,
      publishedUrl: job.publishedUrl,
      publishedAt: job.publishedAt,
      scheduledAt: job.scheduledAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      // The SAME predicate retryPostJob refuses on: a row the usecase would
      // reject must not be offered a button. Notably a `failed` job whose
      // handoff outcome is unknown — its own message tells the operator the
      // system will NOT republish it, so drawing "Chạy lại" next to that
      // sentence invites the exact double post the message warns about.
      canRetry: canOperatorRetryPostJob(job),
    }));

    deps.logger.debug("Post job log read", {
      tenant_id: tenantId,
      filter: {
        batch_id: str(filter.batchId) || null,
        status: rawStatus || null,
        channel: str(filter.channelId) || null,
        product_code: str(filter.productCode).toUpperCase() || null,
      },
      limit,
      returned: items.length,
      has_more: page.nextCursor !== null,
      // How many rows on this page were built from typed data: the cheap
      // version of "which posts did not come from the synced catalog?".
      manual_origin_count: items.filter((item) => item.productOrigin === "manual").length,
    });

    return {
      tenantId,
      items,
      nextCursor: encodePostJobCursor(page.nextCursor),
      limit,
    };
  };
}

export type ListPostJobs = ReturnType<typeof makeListPostJobs>;

// --- cursor codec (pure, owned by core) -------------------------------------

export function encodePostJobCursor(cursor: PostJobCursor | null): string | null {
  if (!cursor || !(cursor.createdAt instanceof Date) || Number.isNaN(cursor.createdAt.getTime())) {
    return null;
  }
  return `${cursor.createdAt.toISOString()}_${cursor.id}`;
}

/**
 * Untrusted input (it travels through a URL). A malformed cursor is INVALID_INPUT,
 * never "start from the beginning" — silently restarting a page loop is how an
 * operator ends up thinking a job disappeared.
 */
export function decodePostJobCursor(
  raw: string | null | undefined,
  context: Record<string, unknown> = {},
): PostJobCursor | null {
  const value = str(raw);
  if (value.length === 0) return null;

  const separator = value.indexOf("_");
  const isoPart = separator > 0 ? value.slice(0, separator) : "";
  const idPart = separator > 0 ? value.slice(separator + 1).trim() : "";
  const createdAtMs = isoPart.length > 0 ? Date.parse(isoPart) : Number.NaN;

  if (!Number.isFinite(createdAtMs) || idPart.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Malformed post job cursor",
      userMessage: "Con trỏ phân trang không hợp lệ — hãy tải lại danh sách.",
      context: { ...context, field: "cursor", value },
    });
  }
  return { createdAt: new Date(createdAtMs), id: idPart };
}

// --- helpers ----------------------------------------------------------------

function normaliseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_POST_JOB_PAGE_SIZE;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new AppError("INVALID_INPUT", {
      message: "limit must be a positive integer",
      userMessage: "Số dòng mỗi trang không hợp lệ.",
      context: { field: "limit", value: raw },
    });
  }
  return Math.min(raw, MAX_POST_JOB_PAGE_SIZE);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
