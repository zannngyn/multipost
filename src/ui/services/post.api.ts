import { DEFAULT_CAPTION_TONE, type CaptionTone } from "@/shared/caption-tone";
import {
  CaptionsResponseSchema,
  ComposeResponseSchema,
  UploadResponseSchema,
  type CaptionsResponse,
  type ComposeResponse,
  type MediaKind,
  type MediaSource,
  type ProductContent,
  type UploadResponse,
  type VideoTarget,
} from "@/ui/schemas/compose.schema";
import type { ManualProductPayload } from "@/ui/schemas/manual-product.schema";
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
import { WorkerHealthSchema, type WorkerHealth } from "@/ui/schemas/worker-health.schema";

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
  batch: (tenantKey: string, batchId: string) => ["posts", tenantKey, "batch", batchId] as const,
  jobs: (tenantKey: string, filter: { status?: string | null; batchId?: string | null }) =>
    ["posts", tenantKey, "jobs", filter.status ?? "all", filter.batchId ?? "all"] as const,
  /** Deliberately NOT under `jobs`: a job-list invalidation must not refetch it. */
  workerHealth: (tenantKey: string) => ["posts", tenantKey, "worker-health"] as const,
};

export interface ComposeParams {
  productCode: string;
  /** Any spelling; empty means "every colour of this code". */
  color?: string;
  /** Absent = ảnh. A video post gathers clips instead and checks their specs. */
  mediaKind?: MediaKind;
  /** Only sent for a video post — the server ignores it for photos anyway. */
  videoTarget?: VideoTarget;
  /** Absent = Drive (chế độ A). "upload" composes from the files just sent. */
  source?: MediaSource;
  /**
   * Onboarding phase 3 — the product typed on the compose screen, for a tenant
   * with no importable catalog.
   *
   * ABSENT and present-but-empty are different requests: absent means "tra mã
   * trong dữ liệu đã đồng bộ". Sending it does NOT skip the stock gate — the
   * server judges `stockRaw` with the same decision table it applies to a synced
   * row, so an empty stock box comes back as a 409, by design.
   */
  manualProduct?: ManualProductPayload | null;
}

export async function composePost(
  params: ComposeParams,
  signal?: AbortSignal,
): Promise<ComposeResponse> {
  const productCode = params.productCode?.trim() ?? "";
  const color = params.color?.trim() ?? "";
  const mediaKind: MediaKind = params.mediaKind === "video" ? "video" : "image";

  // Guard: the usecase requires it, so a round trip would only produce the same
  // 400 we can raise here.
  if (productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "composePost requires a productCode",
      userMessage: "Thiếu mã sản phẩm.",
    });
  }

  return apiRequest("/api/posts/compose", {
    method: "POST",
    body: {
      productCode,
      ...(color ? { color } : {}),
      mediaKind,
      // A video destination is meaningless on a photo post; sending it anyway
      // would let a stale radio value travel with an album.
      ...(mediaKind === "video" && params.videoTarget ? { videoTarget: params.videoTarget } : {}),
      ...(params.source === "upload" ? { source: "upload" as const } : {}),
      // Only when there is one: a `manualProduct: null` on the wire would be a
      // request to type a product with no fields, not a request to look one up.
      ...(params.manualProduct ? { manualProduct: params.manualProduct } : {}),
    },
    schema: ComposeResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu bài đăng trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface UploadMediaParams {
  productCode: string;
  files: readonly File[];
  /** Indexes into `files`; index 0 is the cover. */
  order?: readonly number[];
}

/**
 * E9.1 — send the operator's files (mode B).
 *
 * Multipart, so the browser sets the boundary itself; `apiRequest` passes a
 * FormData body through without touching the headers.
 *
 * A 200 can still carry refusals: `rejected` names the files the server would
 * not take, and the caller must show them. Only a call where NOTHING was usable
 * comes back as an ApiError.
 */
export async function uploadMedia(
  params: UploadMediaParams,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const productCode = params.productCode?.trim() ?? "";
  const files = params.files ?? [];

  if (productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "uploadMedia requires a productCode",
      userMessage: "Nhập mã sản phẩm trước khi tải file lên.",
    });
  }

  if (files.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "uploadMedia requires at least one file",
      userMessage: "Chưa chọn file nào để tải lên.",
    });
  }

  const form = new FormData();
  form.set("productCode", productCode);
  if (params.order) form.set("order", JSON.stringify([...params.order]));
  for (const file of files) form.append("files", file);

  return apiRequest("/api/posts/uploads", {
    method: "POST",
    body: form,
    schema: UploadResponseSchema,
    signal,
    // Uploading bytes is slower than a JSON round trip; the default 15s would
    // abort a legitimate album on a slow connection.
    timeoutMs: 120_000,
    malformedMessage:
      "Kết quả tải file lên không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface GenerateCaptionsParams {
  /**
   * Whitelisted product facts ONLY. `ProductContent` is the only type accepted
   * here, so a price or a stock number has no field to travel in — and the API
   * route rejects any extra key (strict schema at the boundary).
   */
  content: ProductContent;
  channels: readonly string[];
  /**
   * Tông giọng chosen in the caption header. Absent or "mac-dinh" = the writer
   * decides, and NOTHING extra is put on the wire.
   */
  tone?: CaptionTone;
}

/**
 * The server's answer, plus ONE fact about the call itself.
 *
 * Deliberately an EXTENSION of `CaptionsResponse` rather than a wrapper around
 * it: every existing caller (the bulk run) keeps reading `generated` / `failed`
 * exactly as before, and only the compose screen looks at the extra field.
 */
export type GenerateCaptionsResult = CaptionsResponse & {
  /**
   * True when a tone was asked for, refused by the server, and the call was
   * retried without it. The caller MUST say so — silently writing in the
   * default tone while the dropdown claims otherwise is exactly the "im lặng
   * bỏ qua" business rule 5 forbids.
   */
  readonly toneDropped: boolean;
};

function captionsBody(params: GenerateCaptionsParams, withTone: boolean): unknown {
  const tone = params.tone;
  return {
    // Explicit field list: whatever else the compose response carried stays
    // on this side of the wire (business rule 2).
    product: {
      name: params.content.name,
      description: params.content.description ?? "",
      category: params.content.category ?? "",
      season: params.content.season ?? "",
    },
    channels: [...params.channels],
    // The field only exists on the wire when the operator picked something
    // other than the default — a server without the new contract must see the
    // exact body it has always seen.
    ...(withTone && tone && tone !== DEFAULT_CAPTION_TONE ? { tone } : {}),
  };
}

/**
 * True when this 400 is the server refusing the `tone` field itself, rather
 * than refusing the request for a reason a retry cannot fix.
 *
 * Deliberately narrow: only a validation status, and only when the server named
 * `tone` in its issues. Anything broader would retry real validation failures
 * and hide them behind a friendlier message.
 */
function isToneRejection(error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  const issues = error.issues ?? [];
  return issues.some((issue) => issue.path === "tone" || issue.path.startsWith("tone."));
}

export async function generateCaptions(
  params: GenerateCaptionsParams,
  signal?: AbortSignal,
): Promise<GenerateCaptionsResult> {
  if (params.channels.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "generateCaptions requires at least one channel",
      userMessage: "Chưa chọn kênh nào để viết caption.",
    });
  }

  const wantsTone = Boolean(params.tone && params.tone !== DEFAULT_CAPTION_TONE);

  const send = (withTone: boolean) =>
    apiRequest("/api/posts/captions", {
      method: "POST",
      body: captionsBody(params, withTone),
      schema: CaptionsResponseSchema,
      signal,
      timeoutMs: CAPTION_TIMEOUT_MS,
      malformedMessage:
        "Kết quả caption không đúng định dạng. Hãy thử lại hoặc nhập caption tay.",
    });

  if (!wantsTone) return { ...(await send(false)), toneDropped: false };

  try {
    return { ...(await send(true)), toneDropped: false };
  } catch (error) {
    // A deploy older than this build does not know `tone` and answers 400 with
    // the field named. Retrying WITHOUT it means the operator still gets a
    // caption instead of a dead end — and `toneDropped` is what makes the
    // downgrade visible rather than silent. Anything else is rethrown untouched
    // (CLAUDE.md rule 5: never swallow).
    if (!isToneRejection(error)) throw error;
    return { ...(await send(false)), toneDropped: true };
  }
}

// --- Publish (E7.2 / E7.5 / E11.1) ------------------------------------------

export interface CreatePostBatchParams {
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
  const productCode = params.productCode?.trim() ?? "";
  const color = params.color?.trim() ?? "";

  // Guards: a round trip would only return the same 400 we can raise here.
  if (productCode.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createPostBatch requires a productCode",
      userMessage: "Thiếu mã sản phẩm.",
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

  return apiRequest(`/api/posts/batches/${encodeURIComponent(id)}`, {
    schema: BatchStatusResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu lô bài đăng không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ListPostJobsParams {
  status?: PostJobStatus | null;
  batchId?: string | null;
  cursor?: string | null;
  limit?: number;
}

export async function listPostJobs(
  params: ListPostJobsParams,
  signal?: AbortSignal,
): Promise<PostJobLogResponse> {
  const query = new URLSearchParams();
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

/**
 * Is anything draining the publish queue? Read by the job log so a queue nobody
 * serves stops looking like a queue that is merely busy.
 *
 * The endpoint answers 200 even when the queue is unreachable — "không hỏi được"
 * is part of the answer, not an error. A non-200 here therefore means the check
 * itself failed, which the screen shows as its quietest notice.
 */
export async function fetchWorkerHealth(signal?: AbortSignal): Promise<WorkerHealth> {
  return apiRequest("/api/posts/worker-health", {
    schema: WorkerHealthSchema,
    signal,
    malformedMessage:
      "Dữ liệu tình trạng máy đăng bài không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/** Re-queues ONE job. The stock gate still runs before the post goes out. */
export async function retryPostJob(
  params: { postJobId: string },
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
    // The company comes from the session; the route ignores a legacy body.
    body: {},
    schema: RetryPostJobResponseSchema,
    signal,
    malformedMessage:
      "Kết quả chạy lại không đúng định dạng. Hãy tải lại nhật ký để xem trạng thái thật của bài.",
  });
}
