import { z } from "zod";

import type { PostFormat } from "./post-batch.schema";

/**
 * Contracts of the "Soạn bài" wizard (E3 compose + E4 captions).
 *
 * Mirrors `core/domain/product.ts` (ProductContent, MediaAsset),
 * `core/domain/inventory.ts` (InventoryDecision) and the results of
 * `compose-post` / `generate-captions`. `ui/` may not import `core/`
 * (docs/07 §2), so the mirror is intentional and parsed at runtime.
 *
 * CLAUDE.md business rule 2 (whitelist): `ProductContentSchema` holds ONLY the
 * four caption-safe columns. Stock/price/notes have no field here to land in —
 * `InventoryDecisionSchema` is a SEPARATE type, rendered only in the internal
 * operator area and never inside a caption or a post preview.
 */

// --- Channels (Phase 1: Facebook only) --------------------------------------

export const COMPOSE_CHANNELS = [
  { id: "facebook", label: "Facebook", platform: "facebook", contentType: "photo_post" },
] as const;

export type ComposeChannelId = (typeof COMPOSE_CHANNELS)[number]["id"];

// --- Media kind + video destination (Phase 2, E10.1) ------------------------

/**
 * Mirrors `MediaKind` (core/domain/media-file-name) and `VideoTarget`
 * (core/domain/video-spec). The spellings MUST match the server exactly — the
 * API route forwards them straight into `composePost`.
 */
/** Brief §8 — where a post's files come from. */
export const MEDIA_SOURCES = ["drive", "upload"] as const;
export const MediaSourceSchema = z.enum(MEDIA_SOURCES);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

export const MEDIA_SOURCE_LABELS: Record<MediaSource, string> = {
  drive: "Lấy từ Drive theo mã",
  upload: "Tự tải file lên",
};

export const MEDIA_SOURCE_HINTS: Record<MediaSource, string> = {
  drive: "Hệ thống tự tìm ảnh/video trên Drive theo mã sản phẩm và màu.",
  upload: "Dùng khi file chưa có trên Drive, hoặc muốn dùng file khác. Vẫn cần mã sản phẩm để tra Sheet và viết caption.",
};

/** Mirrors MAX_UPLOADS_PER_POST / MAX_UPLOAD_BYTES in core/domain/uploaded-media. */
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

/** Client-side `accept` — a hint for the picker, re-checked on the server. */
export const UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime";

export const UploadedAssetSchema = z.object({
  assetId: z.string(),
  fileName: z.string(),
  kind: z.enum(["image", "video"]),
  sequence: z.number().int().nullable(),
  sizeBytes: z.number().nullable(),
});

export type UploadedAsset = z.infer<typeof UploadedAssetSchema>;

export const UploadRejectionSchema = z.object({
  fileName: z.string(),
  reason: z.string(),
  userMessage: z.string(),
});

export type UploadRejection = z.infer<typeof UploadRejectionSchema>;

export const UploadResponseSchema = z.object({
  accepted: z.array(UploadedAssetSchema),
  rejected: z.array(UploadRejectionSchema),
});

export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const MEDIA_KINDS = ["image", "video"] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const VIDEO_TARGETS = ["facebook_video", "facebook_reels"] as const;
export const VideoTargetSchema = z.enum(VIDEO_TARGETS);
export type VideoTarget = z.infer<typeof VideoTargetSchema>;

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: "Ảnh",
  video: "Video",
};

export const MEDIA_KIND_HINTS: Record<MediaKind, string> = {
  image: "Một bài ảnh gồm 5–10 ảnh, ảnh đầu tiên là ảnh bìa.",
  video: "Một bài video dùng đúng một clip của mã sản phẩm.",
};

export const VIDEO_TARGET_LABELS: Record<VideoTarget, string> = {
  facebook_video: "Video thường",
  facebook_reels: "Reels",
};

/**
 * Short operator-facing summary of the limits enforced server-side
 * (core/domain/video-spec). Kept deliberately short: the binding check is the
 * server's, this text only helps the operator pick the right destination.
 */
export const VIDEO_TARGET_HINTS: Record<VideoTarget, string> = {
  facebook_video: "Đăng lên dòng thời gian của Page. Tỷ lệ 9:16 đến 16:9, tối đa 240 phút.",
  facebook_reels: "Chỉ nhận video dọc 9:16, dài 3–90 giây, tối thiểu 540x960.",
};

/**
 * Post format sent to POST /api/posts/batches — mirrors `PostFormat`.
 *
 * Derived from what the server actually COMPOSED (`ComposeResponse.video`),
 * never from the form: the operator may have changed the radio after composing,
 * and the album on screen is the one that must be published.
 */
export function postFormatForVideo(video: { target: VideoTarget } | null): PostFormat {
  if (!video) return "image_post";
  return video.target === "facebook_reels" ? "reels" : "video_post";
}

// --- Step 1: the wizard form (ONE schema for the whole flow, core-wizard) ---

const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ComposeWizardSchema = z.object({
  // No `tenantId` (M1.4): the company comes from the session, so there is
  // nothing for the operator to type and nothing for the form to validate.
  productCode: z
    .string()
    .trim()
    .min(1, "Nhập mã sản phẩm, ví dụ: MGKVX6310.")
    .max(64, "Mã sản phẩm quá dài (tối đa 64 ký tự).")
    .regex(PRODUCT_CODE_PATTERN, "Mã sản phẩm chỉ gồm chữ, số và các ký tự . _ -"),
  /** Optional colour filter, any spelling — the server normalises TRẮNG/TRANG. */
  color: z.string().trim().max(64, "Tên màu quá dài (tối đa 64 ký tự).").optional(),
  /** Ảnh (mặc định) hay video. Decides which files compose gathers. */
  mediaKind: MediaKindSchema,
  /** Chế độ A (Drive) hay chế độ B (tự tải lên) — brief §8. */
  source: MediaSourceSchema,
  /** Only meaningful for a video post; ignored by the server for photos. */
  videoTarget: VideoTargetSchema,
  /** Caption per channel, edited by hand or filled in by the AI step. */
  captions: z.record(z.string(), z.string()),
});

export type ComposeWizardValues = z.infer<typeof ComposeWizardSchema>;

/** Fields step 1 owns — `trigger()` must not validate steps not reached yet. */
export const STEP_PRODUCT_FIELDS = [
  "productCode",
  "color",
  "mediaKind",
  "videoTarget",
  "source",
] as const;

// --- Step 1 response --------------------------------------------------------

/** The ONLY product fields allowed near a caption (brief §2.2). */
export const ProductContentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  season: z.string().nullable(),
});
export type ProductContent = z.infer<typeof ProductContentSchema>;

export const MediaAssetSchema = z.object({
  driveFileId: z.string().min(1),
  fileName: z.string().min(1),
  color: z.string().nullable(),
  sequence: z.number().nullable(),
  kind: z.enum(["image", "video"]),
  warnings: z.array(z.string()),
  needsReview: z.boolean(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** INTERNAL ONLY — never rendered inside a caption or a post preview. */
export const InventoryDecisionSchema = z.object({
  status: z.enum(["in_stock", "low_stock", "blocked"]),
  blocked: z.boolean(),
  reason: z.string().nullable(),
  stock: z.number().nullable(),
  operatorMessage: z.string().nullable(),
});
export type InventoryDecision = z.infer<typeof InventoryDecisionSchema>;

/**
 * What ffprobe read from the clip — mirrors `VideoSpec` (core/domain/video-spec).
 * INTERNAL operator information, like `inventory`: never part of a caption.
 */
export const VideoSpecSchema = z.object({
  container: z.string(),
  videoCodec: z.string(),
  audioCodec: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  durationSec: z.number(),
  sizeBytes: z.number(),
  fps: z.number().nullable(),
  rotationDegrees: z.number().optional(),
});
export type VideoSpec = z.infer<typeof VideoSpecSchema>;

/**
 * Present on every compose response; `null` for a photo post. `spec` is null
 * when nothing could be probed in the web process — NOT a block: the worker
 * owns ffprobe and re-checks before uploading a byte (same two-pass logic as
 * the stock gate).
 */
export const ComposeVideoSchema = z.object({
  target: VideoTargetSchema,
  spec: VideoSpecSchema.nullable(),
});
export type ComposeVideo = z.infer<typeof ComposeVideoSchema>;

export const ComposeResponseSchema = z.object({
  tenantId: z.string().min(1),
  productCode: z.string().min(1),
  channel: z.string().min(1),
  content: ProductContentSchema,
  inventory: InventoryDecisionSchema.nullable(),
  media: z.array(MediaAssetSchema).min(1),
  availableColors: z.array(z.string()),
  /** Operator notes: several colours, files needing review, low stock… */
  warnings: z.array(z.string()),
  video: ComposeVideoSchema.nullable(),
});
export type ComposeResponse = z.infer<typeof ComposeResponseSchema>;

export const INVENTORY_STATUS_LABELS: Record<InventoryDecision["status"], string> = {
  in_stock: "Còn hàng",
  low_stock: "Sắp hết",
  blocked: "Bị chặn",
};

// --- Reading a video spec out loud (operator area only) ---------------------

/** "12,5 giây" / "2,0 phút" — same wording as the server's own messages. */
export function formatDurationSec(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec < 0) return "—";
  if (durationSec >= 60) return `${(durationSec / 60).toFixed(1).replace(".", ",")} phút`;
  return `${durationSec.toFixed(1).replace(".", ",")} giây`;
}

/** Decimal MB/GB, matching the server's reading of Facebook's limits. */
export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes >= 1_000_000_000) return `${(sizeBytes / 1_000_000_000).toFixed(1).replace(".", ",")} GB`;
  return `${(sizeBytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
}

/** "1080x1920 (9:16)" — the ratio is what decides Reels, so it is spelled out. */
export function formatResolution(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "—";
  return `${width}x${height} (${formatAspectRatio(width / height)})`;
}

function formatAspectRatio(ratio: number): string {
  const tolerance = 0.01;
  if (Math.abs(ratio - 9 / 16) < tolerance) return "9:16";
  if (Math.abs(ratio - 16 / 9) < tolerance) return "16:9";
  if (Math.abs(ratio - 1) < tolerance) return "1:1";
  if (Math.abs(ratio - 4 / 5) < tolerance) return "4:5";
  return `${ratio.toFixed(2).replace(".", ",")}:1`;
}

export function formatFps(fps: number | null): string {
  if (fps === null || !Number.isFinite(fps) || fps <= 0) return "không đọc được";
  return `${Number.isInteger(fps) ? fps : fps.toFixed(1).replace(".", ",")} fps`;
}

/** "H264 + AAC" / "H264, không có tiếng". */
export function formatCodecs(videoCodec: string, audioCodec: string | null): string {
  const video = videoCodec.trim().toUpperCase() || "—";
  if (!audioCodec || audioCodec.trim().length === 0) return `${video}, không có tiếng`;
  return `${video} + ${audioCodec.trim().toUpperCase()}`;
}

// --- Step 2 response --------------------------------------------------------

export const GeneratedCaptionSchema = z.object({
  channelId: z.string().min(1),
  platform: z.string().min(1),
  /** Publish-ready text assembled by the system ("Tên – TIÊU ĐỀ" + body + tag). */
  text: z.string().min(1),
  hashtags: z.array(z.string()),
  model: z.string().min(1),
  provider: z.string().min(1),
});
export type GeneratedCaption = z.infer<typeof GeneratedCaptionSchema>;

export const FailedCaptionSchema = z.object({
  channelId: z.string().min(1),
  platform: z.string().min(1),
  code: z.string().min(1),
  /** Vietnamese reason — always populated by the usecase. */
  reason: z.string().min(1),
});
export type FailedCaption = z.infer<typeof FailedCaptionSchema>;

export const CaptionsResponseSchema = z.object({
  generated: z.array(GeneratedCaptionSchema),
  failed: z.array(FailedCaptionSchema),
});
export type CaptionsResponse = z.infer<typeof CaptionsResponseSchema>;
