import {
  CancelScheduledJobResponseSchema,
  RescheduleJobResponseSchema,
  ScheduledJobsResponseSchema,
  dayEndIso,
  dayStartIso,
  type CancelScheduledJobResponse,
  type RescheduleJobResponse,
  type ScheduledFilter,
  type ScheduledJobsResponse,
} from "@/ui/schemas/scheduled.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of "Bài đã hẹn" (E8.4), docs/07 §4.1.
 * GET /api/posts/scheduled · POST /api/posts/scheduled/:id/reschedule ·
 * POST /api/posts/scheduled/:id/cancel.
 *
 * This is also the ONLY place where the pure dates of the filter become
 * instants: the URL carries "13/08" (what the operator picked), the wire
 * carries the two instants that bound that local day.
 */

/** Query keys of the scheduled screen; one place, so invalidation cannot drift. */
export const scheduledKeys = {
  all: (tenantId: string) => ["posts", tenantId, "scheduled"] as const,
  list: (tenantId: string, filter: ScheduledFilter) =>
    [
      "posts",
      tenantId,
      "scheduled",
      filter.channelId ?? "all",
      filter.from ?? "any",
      filter.to ?? "any",
    ] as const,
};

function requireTenantId(tenantId: string): string {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant).",
    });
  }
  return trimmed;
}

function requireJobId(postJobId: string, action: string): string {
  const trimmed = typeof postJobId === "string" ? postJobId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${action} requires a post job id`,
      userMessage: "Thiếu mã bài đăng.",
    });
  }
  return trimmed;
}

export interface ListScheduledJobsParams {
  tenantId: string;
  filter: ScheduledFilter;
  cursor?: string | null;
  limit?: number;
}

export async function listScheduledJobs(
  params: ListScheduledJobsParams,
  signal?: AbortSignal,
): Promise<ScheduledJobsResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });

  if (params.filter.channelId) query.set("channelId", params.filter.channelId);
  // A malformed day never becomes a request: the helpers return null and the
  // bound is simply dropped, exactly like the URL parser already decided.
  const from = params.filter.from ? dayStartIso(params.filter.from) : null;
  const to = params.filter.to ? dayEndIso(params.filter.to) : null;
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));

  return apiRequest(`/api/posts/scheduled?${query.toString()}`, {
    schema: ScheduledJobsResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu bài đã hẹn không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ReschedulePostJobParams {
  tenantId: string;
  postJobId: string;
  /** An instant. The dialog converts the operator's wall clock before calling. */
  scheduledAt: string;
}

/**
 * Moves ONE scheduled post. Never retried automatically: a QUEUE_ERROR means
 * the new hour is already stored, and a blind second attempt would queue the
 * post twice for it.
 */
export async function reschedulePostJob(
  params: ReschedulePostJobParams,
  signal?: AbortSignal,
): Promise<RescheduleJobResponse> {
  const postJobId = requireJobId(params.postJobId, "reschedulePostJob");
  const scheduledAt = params.scheduledAt?.trim() ?? "";
  if (scheduledAt.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "reschedulePostJob requires a new scheduled time",
      userMessage: "Chưa chọn giờ đăng mới.",
    });
  }

  return apiRequest(`/api/posts/scheduled/${encodeURIComponent(postJobId)}/reschedule`, {
    method: "POST",
    body: { tenantId: requireTenantId(params.tenantId), scheduledAt },
    schema: RescheduleJobResponseSchema,
    signal,
    malformedMessage:
      "Kết quả đổi giờ không đúng định dạng. Hãy tải lại danh sách để xem giờ thật của bài.",
  });
}

export interface CancelScheduledJobParams {
  tenantId: string;
  postJobId: string;
  note?: string;
}

export async function cancelScheduledJob(
  params: CancelScheduledJobParams,
  signal?: AbortSignal,
): Promise<CancelScheduledJobResponse> {
  const postJobId = requireJobId(params.postJobId, "cancelScheduledJob");
  const note = params.note?.trim() ?? "";

  return apiRequest(`/api/posts/scheduled/${encodeURIComponent(postJobId)}/cancel`, {
    method: "POST",
    body: {
      tenantId: requireTenantId(params.tenantId),
      ...(note.length > 0 ? { note } : {}),
    },
    schema: CancelScheduledJobResponseSchema,
    signal,
    malformedMessage:
      "Kết quả huỷ không đúng định dạng. Hãy tải lại danh sách để xem trạng thái thật của bài.",
  });
}
