import {
  CaptionsResponseSchema,
  ComposeResponseSchema,
  type CaptionsResponse,
  type ComposeResponse,
  type MediaKind,
  type ProductContent,
  type VideoTarget,
} from "@/ui/schemas/compose.schema";
import {
  BatchStatusResponseSchema,
  CreateBatchResponseSchema,
  PostJobLogResponseSchema,
  RetryPostJobResponseSchema,
  type BatchStatusResponse,
  type CreateBatchResponse,
  type PostFormat,
  type PostJobLogResponse,
  type PostJobStatus,
  type RetryPostJobResponse,
} from "@/ui/schemas/post-batch.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the compose wizard and the publish screens (docs/07 §4.1).
 * POST /api/posts/compose · POST /api/posts/captions · POST /api/posts/batches ·
 * GET /api/posts/batches/:id · GET /api/posts/jobs · POST /api/posts/jobs/:id/retry.
 *
 * The writes are POST because they start work on the server; none is fail-soft.
 * A blocked product (hết hàng, thiếu ảnh) comes back as an HTTP error carrying
 * the business code — the wizard must stop, not show an empty preview.
 */

/** The AI gateway may escalate models and retry; 15s is not enough. */
const CAPTION_TIMEOUT_MS = 90_000;

/** Query keys of the publish screens; one place, so invalidation cannot drift. */
export const postKeys = {
  batch: (tenantId: string, batchId: string) => ["posts", tenantId, "batch", batchId] as const,
  jobs: (tenantId: string, filter: { status?: string | null; batchId?: string | null }) =>
    ["posts", tenantId, "jobs", filter.status ?? "all", filter.batchId ?? "all"] as const,
};

export interface ComposeParams {
  tenantId: string;
  productCode: string;
  /** Any spelling; empty means "every colour of this code". */
  color?: string;
  /** Absent = ảnh. A video post gathers clips instead and checks their specs. */
  mediaKind?: MediaKind;
  /** Only sent for a video post — the server ignores it for photos anyway. */
  videoTarget?: VideoTarget;
}

export async function composePost(
  params: ComposeParams,
  signal?: AbortSignal,
): Promise<ComposeResponse> {
  const tenantId = params.tenantId?.trim() ?? "";
  const productCode = params.productCode?.trim() ?? "";
  const color = params.color?.trim() ?? "";
  const mediaKind: MediaKind = params.mediaKind === "video" ? "video" : "image";

  // Guards: both are required by the usecase, so a round-trip would only
  // produce the same 400 we can raise here.
  if (tenantId.length === 0 || productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "composePost requires tenantId and productCode",
      userMessage: "Thiếu mã đơn vị hoặc mã sản phẩm.",
    });
  }

  return apiRequest("/api/posts/compose", {
    method: "POST",
    body: {
      tenantId,
      productCode,
      ...(color ? { color } : {}),
      mediaKind,
      // A video destination is meaningless on a photo post; sending it anyway
      // would let a stale radio value travel with an album.
      ...(mediaKind === "video" && params.videoTarget ? { videoTarget: params.videoTarget } : {}),
    },
    schema: ComposeResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu bài đăng trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface GenerateCaptionsParams {
  tenantId: string;
  /**
   * Whitelisted product facts ONLY. `ProductContent` is the only type accepted
   * here, so a price or a stock number has no field to travel in — and the API
   * route rejects any extra key (strict schema at the boundary).
   */
  content: ProductContent;
  channels: readonly string[];
}

export async function generateCaptions(
  params: GenerateCaptionsParams,
  signal?: AbortSignal,
): Promise<CaptionsResponse> {
  const tenantId = params.tenantId?.trim() ?? "";
  if (tenantId.length === 0 || params.channels.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "generateCaptions requires a tenantId and at least one channel",
      userMessage: "Thiếu mã đơn vị hoặc chưa chọn kênh nào để viết caption.",
    });
  }

  return apiRequest("/api/posts/captions", {
    method: "POST",
    body: {
      tenantId,
      // Explicit field list: whatever else the compose response carried stays
      // on this side of the wire (business rule 2).
      product: {
        name: params.content.name,
        description: params.content.description ?? "",
        category: params.content.category ?? "",
        season: params.content.season ?? "",
      },
      channels: [...params.channels],
    },
    schema: CaptionsResponseSchema,
    signal,
    timeoutMs: CAPTION_TIMEOUT_MS,
    malformedMessage:
      "Kết quả caption không đúng định dạng. Hãy thử lại hoặc nhập caption tay.",
  });
}

// --- Publish (E7.2 / E7.5 / E11.1) ------------------------------------------

export interface CreatePostBatchParams {
  tenantId: string;
  productCode: string;
  color?: string;
  /** Absent = `image_post`. A video format takes exactly one video asset. */
  format?: PostFormat;
  channelIds: readonly string[];
  /** One caption per channel id — the server refuses a missing one by name. */
  captionByChannel: Readonly<Record<string, string>>;
  /** Assets only, cover first. The public URL is minted server-side (E3.6). */
  media: readonly { driveFileId: string; fileName?: string; kind?: string }[];
  /**
   * E8.1 — publish time for every channel of this batch, as an INSTANT (ISO).
   * Absent/null = đăng ngay. The window (tương lai, tối đa 30 ngày) is enforced
   * by the domain: a bad time blocks ONE channel with a reason, never the lô.
   */
  scheduledAt?: string | null;
}

/**
 * Creates the batch and its per-channel jobs. Never retried automatically: a
 * second call with no batch id would fan the same post out twice.
 */
export async function createPostBatch(
  params: CreatePostBatchParams,
  signal?: AbortSignal,
): Promise<CreateBatchResponse> {
  const tenantId = params.tenantId?.trim() ?? "";
  const productCode = params.productCode?.trim() ?? "";
  const color = params.color?.trim() ?? "";

  // Guards: a round trip would only return the same 400 we can raise here.
  if (tenantId.length === 0 || productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createPostBatch requires tenantId and productCode",
      userMessage: "Thiếu mã đơn vị hoặc mã sản phẩm.",
    });
  }
  if (params.channelIds.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createPostBatch requires at least one channel",
      userMessage: "Chọn ít nhất một kênh để đăng.",
    });
  }
  if (params.media.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createPostBatch requires at least one media asset",
      userMessage: "Bài đăng chưa có ảnh nào.",
    });
  }
  // A video post carries exactly one clip (core/domain/post-job). Catching it
  // here names the problem before a round trip; the server enforces it too.
  const isVideoFormat = params.format === "video_post" || params.format === "reels";
  if (isVideoFormat && params.media.length !== 1) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `A ${params.format} post takes exactly one video, got ${params.media.length}`,
      userMessage: "Bài video chỉ đăng được đúng một clip. Hãy soạn lại bài.",
    });
  }

  const scheduledAt = params.scheduledAt?.trim() ?? "";

  return apiRequest("/api/posts/batches", {
    method: "POST",
    body: {
      tenantId,
      productCode,
      ...(color ? { color } : {}),
      ...(params.format ? { format: params.format } : {}),
      ...(scheduledAt ? { scheduledAt } : {}),
      channelIds: [...params.channelIds],
      captionByChannel: params.captionByChannel,
      // Explicit field list: no URL, no stock, no price travels with a post.
      media: params.media.map((item) => ({
        driveFileId: item.driveFileId,
        fileName: item.fileName,
        kind: item.kind,
      })),
    },
    schema: CreateBatchResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tạo lô đăng không đúng định dạng. Lô có thể đã được tạo — hãy mở nhật ký đăng bài để kiểm tra.",
  });
}

export async function fetchBatchStatus(
  tenantId: string,
  batchId: string,
  signal?: AbortSignal,
): Promise<BatchStatusResponse> {
  const id = batchId?.trim() ?? "";
  if (id.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "fetchBatchStatus requires a batch id",
      userMessage: "Thiếu mã lô bài đăng.",
    });
  }

  const query = new URLSearchParams({ tenantId: requirePostTenantId(tenantId) });
  return apiRequest(`/api/posts/batches/${encodeURIComponent(id)}?${query.toString()}`, {
    schema: BatchStatusResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu lô bài đăng không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ListPostJobsParams {
  tenantId: string;
  status?: PostJobStatus | null;
  batchId?: string | null;
  cursor?: string | null;
  limit?: number;
}

export async function listPostJobs(
  params: ListPostJobsParams,
  signal?: AbortSignal,
): Promise<PostJobLogResponse> {
  const query = new URLSearchParams({ tenantId: requirePostTenantId(params.tenantId) });
  if (params.status) query.set("status", params.status);
  if (params.batchId) query.set("batchId", params.batchId);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));

  return apiRequest(`/api/posts/jobs?${query.toString()}`, {
    schema: PostJobLogResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu nhật ký đăng bài không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/** Re-queues ONE job. The stock gate still runs before the post goes out. */
export async function retryPostJob(
  params: { tenantId: string; postJobId: string },
  signal?: AbortSignal,
): Promise<RetryPostJobResponse> {
  const postJobId = params.postJobId?.trim() ?? "";
  if (postJobId.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "retryPostJob requires a post job id",
      userMessage: "Thiếu mã bài đăng cần chạy lại.",
    });
  }

  return apiRequest(`/api/posts/jobs/${encodeURIComponent(postJobId)}/retry`, {
    method: "POST",
    body: { tenantId: requirePostTenantId(params.tenantId) },
    schema: RetryPostJobResponseSchema,
    signal,
    malformedMessage:
      "Kết quả chạy lại không đúng định dạng. Hãy tải lại nhật ký để xem trạng thái thật của bài.",
  });
}

function requirePostTenantId(tenantId: string): string {
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
