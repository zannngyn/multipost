import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E7.2 — the wizard's final action: fan one approved post out to N channels.
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * What the body does NOT carry, on purpose:
 *  - no image URL. The screen sends the ASSETS (drive file id + name + kind);
 *    the signed public URL Facebook fetches is minted server-side by
 *    `createPostBatch`, so a browser can neither forge nor leak one.
 *  - no stock, no price, no note (business rule 2). The caption text is the
 *    only free-form field, and it was approved by a human on step 2.
 *
 * The stock gate runs INSIDE the usecase before anything is queued (rule 1),
 * and again in the worker right before the Graph call (rule 3) — this route
 * adds no business decision of its own.
 */

const ROUTE = "POST /api/posts/batches";

/** Facebook feed albums take at most 10 attachments (core/domain/post-job). */
const MAX_ALBUM_MEDIA = 10;
const MAX_CHANNELS = 50;
/** A caption longer than this is a paste accident, not a post. */
const MAX_CAPTION_LENGTH = 20_000;

const MediaItemSchema = z.object({
  driveFileId: z
    .string({ error: "Thiếu mã file ảnh." })
    .trim()
    .min(1, "Thiếu mã file ảnh.")
    .max(256, "Mã file ảnh quá dài."),
  fileName: z.string().trim().max(512, "Tên file quá dài.").optional(),
  /** Phase 1 publishes images; the usecase refuses a video item with a reason. */
  kind: z.enum(["image", "video"]).optional(),
});

const BodySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
  /** Same id twice = the same batch (idempotency), never a second fan-out. */
  batchId: uuidField("Mã lô bài đăng không hợp lệ.").optional(),
  productCode: z
    .string({ error: "Thiếu mã sản phẩm." })
    .trim()
    .min(1, "Thiếu mã sản phẩm.")
    .max(64, "Mã sản phẩm quá dài."),
  color: z.string().trim().max(64, "Tên màu quá dài.").optional(),
  /**
   * Absent = `image_post` (Phase 1 behaviour). Spelled exactly as `PostFormat`
   * (core/domain/post-job). A video format takes EXACTLY one video item — the
   * usecase enforces that and names the mismatch, this schema does not guess.
   */
  format: z
    .enum(["image_post", "video_post", "reels"], {
      error: "Loại bài chỉ nhận bài ảnh, video thường hoặc Reels.",
    })
    .optional(),
  channelIds: z
    .array(z.string().trim().min(1, "Mã kênh không hợp lệ."))
    .min(1, "Chọn ít nhất một kênh để đăng.")
    .max(MAX_CHANNELS, `Một lô chỉ đăng tối đa ${MAX_CHANNELS} kênh.`),
  /** One caption per channel — the usecase rejects a missing one by name. */
  captionByChannel: z.record(
    z.string().trim().min(1),
    z.string().trim().min(1, "Caption rỗng.").max(MAX_CAPTION_LENGTH, "Caption quá dài."),
  ),
  media: z
    .array(MediaItemSchema)
    .min(1, "Bài đăng cần ít nhất một ảnh.")
    .max(MAX_ALBUM_MEDIA, `Một bài chỉ đăng tối đa ${MAX_ALBUM_MEDIA} ảnh.`),
  /**
   * E8.1 — publish time for every channel of this batch. Absent = đăng ngay.
   * An INSTANT: the browser owns the operator's timezone and converts the wall
   * clock they typed. The window (ít nhất 1 giây, tối đa 30 ngày) belongs to
   * the domain, not to this schema — a bad time must block ONE channel with a
   * reason, not reject the whole lô (business rule 6).
   */
  scheduledAt: z.iso.datetime({ error: "Giờ hẹn đăng không hợp lệ." }).optional(),
  /** E8.1 — per-channel override; wins over `scheduledAt` where it is set. */
  scheduledAtByChannel: z
    .record(
      z.string().trim().min(1, "Mã kênh không hợp lệ."),
      z.iso.datetime({ error: "Giờ hẹn đăng của kênh không hợp lệ." }),
    )
    .optional(),
});

/** ISO strings -> Date, one entry per channel actually named by the caller. */
function toScheduleMap(
  raw: Record<string, string> | undefined,
): Record<string, Date> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([channelId, iso]) => [channelId, new Date(iso)]));
}

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const color = body.color?.trim() ?? "";
    const scheduledAtByChannel = toScheduleMap(body.scheduledAtByChannel);

    const result = await container.usecases.createPostBatch({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      batchId: body.batchId,
      productCode: body.productCode,
      color: color.length > 0 ? color : undefined,
      ...(body.format ? { format: body.format } : {}),
      channelIds: body.channelIds,
      captionByChannel: body.captionByChannel,
      media: body.media,
      ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
      ...(scheduledAtByChannel ? { scheduledAtByChannel } : {}),
    });

    // 201: the batch and its per-channel jobs now exist as rows, whatever the
    // queue did next (a blocked channel is a created job, not a failed call).
    return Response.json(result, { status: 201 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
