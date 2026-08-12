import {
  CaptionsResponseSchema,
  ComposeResponseSchema,
  type CaptionsResponse,
  type ComposeResponse,
  type ProductContent,
} from "@/ui/schemas/compose.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the compose wizard (docs/07 §4.1).
 * POST /api/posts/compose · POST /api/posts/captions.
 *
 * Both are POST because they start work on the server; neither is fail-soft.
 * A blocked product (hết hàng, thiếu ảnh) comes back as an HTTP error carrying
 * the business code — the wizard must stop, not show an empty preview.
 */

/** The AI gateway may escalate models and retry; 15s is not enough. */
const CAPTION_TIMEOUT_MS = 90_000;

export interface ComposeParams {
  tenantId: string;
  productCode: string;
  /** Any spelling; empty means "every colour of this code". */
  color?: string;
}

export async function composePost(
  params: ComposeParams,
  signal?: AbortSignal,
): Promise<ComposeResponse> {
  const tenantId = params.tenantId?.trim() ?? "";
  const productCode = params.productCode?.trim() ?? "";
  const color = params.color?.trim() ?? "";

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
    body: { tenantId, productCode, ...(color ? { color } : {}) },
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
