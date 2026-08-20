import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * Step 1 of the wizard: look a product up, run the stock gate, gather the album
 * (E3). Thin by contract (docs/07 §3.3).
 *
 * Blocked vs failed — the one decision this route makes:
 * `composePost` returns a block (hết hàng, thiếu ảnh, sai màu) as a VALUE, so a
 * batch of 50 codes can keep going. A single interactive request has no batch to
 * protect, and the wizard must stop dead: the block is therefore re-raised as an
 * AppError carrying the business code, which `mapAppErrorToHttp` turns into
 * 409 OUT_OF_STOCK / 404 MEDIA_NOT_FOUND / 404 PRODUCT_NOT_FOUND. The operator
 * gets the usecase's own Vietnamese sentence, unchanged.
 *
 * Whitelist (business rule 2): the response carries `content` (tên, mô tả,
 * chủng loại, mùa vụ) plus the internal `inventory`/`warnings` block. The
 * usecase never returns prices, and nothing here adds them.
 */

const ROUTE = "POST /api/posts/compose";

/** Phase 1 publishes to Facebook only; the field exists so E5 can widen it. */
const DEFAULT_CHANNEL = "facebook";

const BodySchema = z.object({
  tenantId: z.string({ error: "Thiếu mã đơn vị (tenant)." }).trim().min(1, "Thiếu mã đơn vị (tenant)."),
  productCode: z
    .string({ error: "Thiếu mã sản phẩm." })
    .trim()
    .min(1, "Thiếu mã sản phẩm.")
    .max(64, "Mã sản phẩm quá dài."),
  /** Any spelling — the domain normalises TRANG/TRẮNG before matching. */
  color: z.string().trim().max(64, "Tên màu quá dài.").optional(),
  channel: z.literal(DEFAULT_CHANNEL).optional(),
  /** Phase 2: which files to gather. Absent = ảnh, the Phase 1 behaviour. */
  mediaKind: z.enum(["image", "video"], { error: "Loại bài chỉ nhận Ảnh hoặc Video." }).optional(),
  /**
   * E9 (brief §8): where the files come from. Absent = Drive, so every existing
   * caller keeps mode A behaviour without changing.
   */
  source: z
    .enum(["drive", "upload"], { error: "Nguồn file chỉ nhận Drive hoặc Tự tải lên." })
    .optional(),
  /**
   * Destination the clip must satisfy. Spelled exactly as `VideoTarget`
   * (core/domain/video-spec) — the usecase rejects anything else. Ignored for a
   * photo post; the usecase applies its own default when absent.
   */
  videoTarget: z
    .enum(["facebook_video", "facebook_reels"], {
      error: "Đích đăng video chỉ nhận Video thường hoặc Reels.",
    })
    .optional(),
});

/**
 * `composePost` reports a video failure as a block whose `code` predates the
 * dedicated error codes (INVALID_INPUT / INTERNAL) and whose `reason` carries
 * the real meaning. This route is the HTTP boundary, so it restores the honest
 * code — 422 VIDEO_SPEC_INVALID / 422 VIDEO_PROBE_FAILED — instead of telling
 * the operator their input was malformed or that the server crashed.
 */
const BLOCK_REASON_TO_CODE = {
  VIDEO_SPEC_INVALID: "VIDEO_SPEC_INVALID",
  VIDEO_PROBE_FAILED: "VIDEO_PROBE_FAILED",
} as const;

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const color = body.color?.trim() ?? "";

    const mediaKind = body.mediaKind ?? "image";
    const result = await container.usecases.composePost({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      productCode: body.productCode,
      channel: body.channel ?? DEFAULT_CHANNEL,
      colors: color.length > 0 ? [color] : undefined,
      mediaKind,
      ...(body.videoTarget ? { videoTarget: body.videoTarget } : {}),
      ...(body.source ? { source: body.source } : {}),
    });

    // --- Blocked first: nothing downstream may see a half-composed post -----
    if (result.blocked) {
      const code =
        BLOCK_REASON_TO_CODE[result.blocked.reason as keyof typeof BLOCK_REASON_TO_CODE] ??
        result.blocked.code;

      throw new AppError(code, {
        message: `Compose blocked: ${result.blocked.reason}`,
        userMessage: result.blocked.userMessage,
        context: {
          route: ROUTE,
          tenant_id: body.tenantId,
          product_code: body.productCode,
          channel: body.channel ?? DEFAULT_CHANNEL,
          reason: result.blocked.reason,
          available_colors: result.availableColors,
          media_kind: mediaKind,
          media_source: body.source ?? "drive",
          video_target: result.video?.target ?? body.videoTarget ?? null,
        },
      });
    }

    const { blocked: _blocked, ...payload } = result;
    return Response.json(payload);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
