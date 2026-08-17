import { AppError } from "@/core/domain/errors";
import {
  postJobOperatorMessage,
  type PostFormat,
  type PostJobStatus,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { PostJobRepo, ScheduledJobCursor } from "@/core/ports/post-job-repo";

/**
 * E8.4 — "bài đã hẹn": what is going to publish, and when. READ ONLY.
 *
 * SOONEST FIRST, the opposite of the job log (E11.1): this screen answers "cái
 * gì sắp lên?", so the next event belongs at the top.
 *
 * Only `queued` jobs with a `scheduled_at` appear. A job whose time already
 * passed but is still queued (worker down, long spacing) is INCLUDED and marked
 * `overdue` — hiding it is how a stuck schedule stays invisible.
 */

export const DEFAULT_SCHEDULED_PAGE_SIZE = 50;
export const MAX_SCHEDULED_PAGE_SIZE = 200;

export interface ListScheduledJobsFilter {
  /** Inclusive lower bound (ISO string or Date). */
  readonly from?: Date | string | null;
  /** Exclusive upper bound. */
  readonly to?: Date | string | null;
  readonly channelId?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ListScheduledJobsInput {
  readonly tenantId: string;
  readonly filter?: ListScheduledJobsFilter;
}

export interface ScheduledJobEntry {
  readonly postJobId: string;
  readonly batchId: string;
  readonly productCode: string;
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
  readonly status: PostJobStatus;
  readonly scheduledAt: Date;
  /** Milliseconds until publish; negative when the time already passed. */
  readonly startsInMs: number;
  /** True when the scheduled time has passed and the post is still waiting. */
  readonly overdue: boolean;
  readonly captionPreview: string;
  readonly mediaCount: number;
  readonly userMessage: string;
  /** Both operations of E8.4 are only possible before the time comes. */
  readonly canReschedule: boolean;
  readonly canCancel: boolean;
  readonly createdAt: Date;
}

export interface ListScheduledJobsResult {
  readonly tenantId: string;
  readonly items: readonly ScheduledJobEntry[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface ListScheduledJobsDeps {
  postJobs: PostJobRepo;
  clock: Clock;
  logger: Logger;
}

/** Characters of a caption kept for the list row. */
const CAPTION_PREVIEW_LENGTH = 80;

export function makeListScheduledJobs(deps: ListScheduledJobsDeps) {
  return async function listScheduledJobs(
    input: ListScheduledJobsInput,
  ): Promise<ListScheduledJobsResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = str(input?.tenantId);
    if (!isTenantId(tenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "listScheduledJobs requires a tenant UUID",
        userMessage: "Yêu cầu xem bài đã hẹn thiếu mã đơn vị.",
        context: { tenant_id: tenantId || null },
      });
    }

    const filter = input?.filter ?? {};
    const limit = normaliseLimit(filter.limit);
    const from = parseBound(filter.from, "from", tenantId);
    const to = parseBound(filter.to, "to", tenantId);
    if (from && to && to.getTime() <= from.getTime()) {
      // An empty window returns nothing forever; say so instead of showing "".
      throw new AppError("INVALID_INPUT", {
        message: "The scheduled window ends before it starts",
        userMessage: "Khoảng thời gian lọc không hợp lệ: giờ kết thúc phải sau giờ bắt đầu.",
        context: { tenant_id: tenantId, from: from.toISOString(), to: to.toISOString() },
      });
    }
    const cursor = decodeScheduledCursor(filter.cursor, { tenant_id: tenantId });

    const page = await deps.postJobs.listScheduledJobs({
      tenantId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(str(filter.channelId) ? { channelId: str(filter.channelId) } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });

    const nowMs = deps.clock.nowMs();
    const items: ScheduledJobEntry[] = [];
    for (const job of page.items) {
      // The repo filters on NOT NULL, but the type is nullable: skip instead of
      // publishing a NaN countdown to the screen.
      if (!(job.scheduledAt instanceof Date)) continue;
      const startsInMs = job.scheduledAt.getTime() - nowMs;
      const overdue = startsInMs < 0;
      items.push({
        postJobId: job.id,
        batchId: job.batchId,
        productCode: job.productCode,
        color: job.color,
        channelId: job.channelId,
        format: job.format,
        status: job.status,
        scheduledAt: job.scheduledAt,
        startsInMs,
        overdue,
        captionPreview: preview(job.captionText),
        mediaCount: job.media.length,
        userMessage: overdue
          ? "Đã quá giờ hẹn mà bài chưa lên — kiểm tra worker hoặc giãn cách kênh."
          : postJobOperatorMessage(job),
        // Once the time has passed a worker may already be publishing it; the
        // repo's optimistic guard has the final say, this only shapes the UI.
        //
        // E8.6: a post FACEBOOK is holding can still be cancelled (the cancel
        // deletes it there) but NOT rescheduled — our row does not decide its
        // hour any more. Offering a button that always fails would be worse
        // than not offering it.
        canReschedule: !overdue && job.status === "queued",
        canCancel: !overdue,
        createdAt: job.createdAt,
      });
    }

    deps.logger.debug("Scheduled jobs read", {
      tenant_id: tenantId,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      channel: str(filter.channelId) || null,
      returned: items.length,
      overdue: items.filter((item) => item.overdue).length,
      has_more: page.nextCursor !== null,
    });

    return {
      tenantId,
      items,
      nextCursor: encodeScheduledCursor(page.nextCursor),
      limit,
    };
  };
}

export type ListScheduledJobs = ReturnType<typeof makeListScheduledJobs>;

// --- cursor codec (pure, owned by core) -------------------------------------

export function encodeScheduledCursor(cursor: ScheduledJobCursor | null): string | null {
  if (!cursor || !(cursor.scheduledAt instanceof Date)) return null;
  if (!Number.isFinite(cursor.scheduledAt.getTime())) return null;
  return `${cursor.scheduledAt.toISOString()}_${cursor.id}`;
}

export function decodeScheduledCursor(
  raw: string | null | undefined,
  context: Record<string, unknown> = {},
): ScheduledJobCursor | null {
  const value = str(raw);
  if (value.length === 0) return null;

  const separator = value.indexOf("_");
  const isoPart = separator > 0 ? value.slice(0, separator) : "";
  const idPart = separator > 0 ? value.slice(separator + 1).trim() : "";
  const ms = isoPart.length > 0 ? Date.parse(isoPart) : Number.NaN;
  if (!Number.isFinite(ms) || idPart.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Malformed scheduled-jobs cursor",
      userMessage: "Con trỏ phân trang không hợp lệ — hãy tải lại danh sách.",
      context: { ...context, field: "cursor", value },
    });
  }
  return { scheduledAt: new Date(ms), id: idPart };
}

// --- helpers ----------------------------------------------------------------

function parseBound(value: unknown, field: string, tenantId: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new AppError("INVALID_INPUT", {
      message: `${field} is not a valid date`,
      userMessage: "Khoảng thời gian lọc không hợp lệ.",
      context: { tenant_id: tenantId, field, value: String(value) },
    });
  }
  return date;
}

function normaliseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_SCHEDULED_PAGE_SIZE;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new AppError("INVALID_INPUT", {
      message: "limit must be a positive integer",
      userMessage: "Số dòng mỗi trang không hợp lệ.",
      context: { field: "limit", value: raw },
    });
  }
  return Math.min(raw, MAX_SCHEDULED_PAGE_SIZE);
}

function preview(caption: string): string {
  const text = typeof caption === "string" ? caption.trim().replace(/\s+/g, " ") : "";
  return text.length > CAPTION_PREVIEW_LENGTH
    ? `${text.slice(0, CAPTION_PREVIEW_LENGTH)}…`
    : text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
