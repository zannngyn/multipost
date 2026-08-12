import { z } from "zod";

/**
 * Contracts of the publish screens (E7.5 theo dõi lô + E11.1 nhật ký job).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * MIRROR `core/domain/post-job.ts` (statuses), `core/usecases/get-batch-status`,
 * `core/usecases/list-post-jobs` and `core/usecases/create-post-batch`. The
 * runtime parse in `http-client` is what makes a drift loud instead of silent.
 *
 * Business rule 2 (whitelist): nothing here has a field for stock, price or
 * production notes. `warnings[]` is the internal operator channel — rendered in
 * its own block, never inside a caption preview.
 */

// --- Statuses (mirror of the domain state machine) --------------------------

export const POST_JOB_STATUSES = [
  "draft",
  "queued",
  "publishing",
  "published",
  "failed",
  "blocked",
] as const;
export const PostJobStatusSchema = z.enum(POST_JOB_STATUSES);
export type PostJobStatus = z.infer<typeof PostJobStatusSchema>;

export const POST_BATCH_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  "blocked",
  "failed",
] as const;
export const PostBatchStatusSchema = z.enum(POST_BATCH_STATUSES);
export type PostBatchStatus = z.infer<typeof PostBatchStatusSchema>;

export const PostFormatSchema = z.enum(["image_post", "video_post", "reels"]);
export type PostFormat = z.infer<typeof PostFormatSchema>;

/** Statuses the operator may re-run by hand — mirrors RETRYABLE_POST_JOB_STATUSES. */
export const RETRYABLE_POST_JOB_STATUSES: readonly PostJobStatus[] = ["failed", "blocked"];

/** Nothing is running any more — mirrors SETTLED_POST_JOB_STATUSES. */
const SETTLED_POST_JOB_STATUSES: readonly PostJobStatus[] = ["published", "failed", "blocked"];

/** A batch nobody is working on any more: polling must stop here. */
const SETTLED_BATCH_STATUSES: readonly PostBatchStatus[] = [
  "completed",
  "partial",
  "blocked",
  "failed",
];

export function isSettledJobStatus(status: PostJobStatus): boolean {
  return SETTLED_POST_JOB_STATUSES.includes(status);
}

export function isSettledBatchStatus(status: PostBatchStatus): boolean {
  return SETTLED_BATCH_STATUSES.includes(status);
}

// --- Labels + tones (one mapping, reused by every screen) -------------------

export const POST_JOB_STATUS_LABELS: Record<PostJobStatus, string> = {
  draft: "Nháp",
  queued: "Chờ đăng",
  publishing: "Đang đăng",
  published: "Đã đăng",
  failed: "Lỗi",
  blocked: "Bị chặn",
};

export const POST_BATCH_STATUS_LABELS: Record<PostBatchStatus, string> = {
  pending: "Chưa chạy",
  running: "Đang chạy",
  completed: "Đã đăng đủ",
  partial: "Đăng một phần",
  blocked: "Bị chặn",
  failed: "Lỗi",
};

/** Badge tone per status — mirrors the `BadgeTone` union of ui/components/ui/badge. */
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export const POST_JOB_STATUS_TONES: Record<PostJobStatus, StatusTone> = {
  draft: "neutral",
  queued: "info",
  publishing: "info",
  published: "success",
  failed: "danger",
  // Blocked is a RULE saying no (hết hàng, kênh chưa cấu hình), not a crash.
  blocked: "warning",
};

export const POST_BATCH_STATUS_TONES: Record<PostBatchStatus, StatusTone> = {
  pending: "neutral",
  running: "info",
  completed: "success",
  partial: "warning",
  blocked: "warning",
  failed: "danger",
};

// --- Create a batch (POST /api/posts/batches) -------------------------------

export const CreateBatchChannelResultSchema = z.object({
  channelId: z.string().min(1),
  postJobId: z.string().min(1),
  status: PostJobStatusSchema,
  queued: z.boolean(),
  queueJobId: z.string().nullable(),
  errorCode: z.string().nullable(),
  userMessage: z.string().nullable(),
  /** E8.1 — publish time actually stored for this channel; null = đăng ngay. */
  scheduledAt: z.iso.datetime().nullable(),
});
export type CreateBatchChannelResult = z.infer<typeof CreateBatchChannelResultSchema>;

export const CreateBatchResponseSchema = z.object({
  tenantId: z.string().min(1),
  batchId: z.string().min(1),
  productCode: z.string().min(1),
  color: z.string(),
  format: PostFormatSchema,
  batchStatus: PostBatchStatusSchema,
  channels: z.array(CreateBatchChannelResultSchema),
  /** Internal operator notes (sắp hết hàng…). Never part of a caption. */
  warnings: z.array(z.string()),
});
export type CreateBatchResponse = z.infer<typeof CreateBatchResponseSchema>;

// --- Batch status (GET /api/posts/batches/:id) ------------------------------

export const BatchChannelStatusSchema = z.object({
  channelId: z.string().min(1),
  postJobId: z.string().min(1),
  status: PostJobStatusSchema,
  attemptCount: z.number(),
  publishedPostId: z.string().nullable(),
  publishedUrl: z.url().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  /** Vietnamese sentence built by the usecase — always populated. */
  userMessage: z.string(),
});
export type BatchChannelStatus = z.infer<typeof BatchChannelStatusSchema>;

export const BatchTotalsSchema = z.object({
  total: z.number(),
  published: z.number(),
  failed: z.number(),
  blocked: z.number(),
  queued: z.number(),
  publishing: z.number(),
  draft: z.number(),
  inProgress: z.number(),
});
export type BatchTotals = z.infer<typeof BatchTotalsSchema>;

export const BatchStatusResponseSchema = z.object({
  tenantId: z.string().min(1),
  batchId: z.string().min(1),
  productCode: z.string().min(1),
  color: z.string(),
  format: PostFormatSchema,
  status: PostBatchStatusSchema,
  totals: BatchTotalsSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().nullable(),
  channels: z.array(BatchChannelStatusSchema),
  summaryMessage: z.string(),
});
export type BatchStatusResponse = z.infer<typeof BatchStatusResponseSchema>;

// --- Job log (GET /api/posts/jobs) ------------------------------------------

export const PostJobLogEntrySchema = z.object({
  postJobId: z.string().min(1),
  batchId: z.string().min(1),
  productCode: z.string().min(1),
  color: z.string(),
  channelId: z.string().min(1),
  format: PostFormatSchema,
  status: PostJobStatusSchema,
  attemptCount: z.number(),
  lastErrorCode: z.string().nullable(),
  userMessage: z.string(),
  publishedPostId: z.string().nullable(),
  publishedUrl: z.url().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  scheduledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Decided by the server (failed/blocked only) — the UI never guesses it. */
  canRetry: z.boolean(),
});
export type PostJobLogEntry = z.infer<typeof PostJobLogEntrySchema>;

export const PostJobLogResponseSchema = z.object({
  tenantId: z.string().min(1),
  items: z.array(PostJobLogEntrySchema),
  /** Opaque; `null` means this was the last page. */
  nextCursor: z.string().nullable(),
  limit: z.number(),
});
export type PostJobLogResponse = z.infer<typeof PostJobLogResponseSchema>;

// --- Retry (POST /api/posts/jobs/:id/retry) ---------------------------------

export const RetryPostJobResponseSchema = z.object({
  tenantId: z.string().min(1),
  postJobId: z.string().min(1),
  batchId: z.string().min(1),
  channelId: z.string().min(1),
  productCode: z.string().min(1),
  previousStatus: PostJobStatusSchema,
  status: PostJobStatusSchema,
  queueJobId: z.string().min(1),
  attemptCount: z.number(),
  userMessage: z.string(),
});
export type RetryPostJobResponse = z.infer<typeof RetryPostJobResponseSchema>;

// --- Job log filter (URL is the source of truth, core-data-list-query) ------

export const JOB_LOG_DEFAULT_LIMIT = 25;

export interface JobLogFilter {
  /** `null` = every status (the default, which is NOT written to the URL). */
  status: PostJobStatus | null;
  batchId: string | null;
}

/** Parses `?status=&batchId=`; an invalid value falls back to the default. */
export function parseJobLogFilter(params: URLSearchParams): JobLogFilter {
  const rawStatus = params.get("status");
  const status = PostJobStatusSchema.safeParse(rawStatus);
  const batchId = params.get("batchId")?.trim() ?? "";
  return {
    status: status.success ? status.data : null,
    batchId: batchId.length > 0 ? batchId : null,
  };
}

/**
 * THE single query-string builder for the job log (core-data-list-query rule 2).
 * Defaults are omitted so a shared link stays clean.
 */
export function jobLogSearchParams(filter: JobLogFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.batchId) params.set("batchId", filter.batchId);
  return params;
}

/** Facebook post permalink; used when the server did not store one. */
export function facebookPostUrl(publishedPostId: string): string {
  return `https://www.facebook.com/${publishedPostId}`;
}

/** Same wording as the sync screen so one app does not speak two dialects. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

/** "2 phút 5 giây" — a duration an operator can read out loud. */
export function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} giây`;
  return `${minutes} phút ${seconds} giây`;
}
