import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

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
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const color = body.color?.trim() ?? "";

    const result = await container.usecases.composePost({
      tenantId: body.tenantId,
      productCode: body.productCode,
      channel: body.channel ?? DEFAULT_CHANNEL,
      colors: color.length > 0 ? [color] : undefined,
    });

    // --- Blocked first: nothing downstream may see a half-composed post -----
    if (result.blocked) {
      throw new AppError(result.blocked.code, {
        message: `Compose blocked: ${result.blocked.reason}`,
        userMessage: result.blocked.userMessage,
        context: {
          route: ROUTE,
          tenant_id: body.tenantId,
          product_code: body.productCode,
          channel: body.channel ?? DEFAULT_CHANNEL,
          reason: result.blocked.reason,
          available_colors: result.availableColors,
        },
      });
    }

    const { blocked: _blocked, ...payload } = result;
    return Response.json(payload);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
