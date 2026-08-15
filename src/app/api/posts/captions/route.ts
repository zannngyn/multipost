import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";

/**
 * Step 2 of the wizard: one caption per channel (E4). Thin by contract.
 *
 * Whitelist enforced AT THE BOUNDARY (business rule 2): `ProductSchema` is
 * STRICT and holds exactly the four caption-safe columns. A body carrying
 * `stock`, `price` or `note` is rejected with 400 instead of being quietly
 * stripped — a client trying to send them is a bug that must be visible.
 *
 * With no AI key configured — today that means OPENAI_API_KEY, the only required
 * one (single-provider decision 15/08/2026) — the composition root throws
 * INVALID_INPUT naming the missing variable; the wizard turns that into "chưa
 * cấu hình AI" and falls back to typing the caption by hand. That is the
 * expected Phase 1 behaviour.
 */

const ROUTE = "POST /api/posts/captions";

/** Phase 1 catalogue. Widened by E5/E7 when TikTok lands. */
const CHANNEL_CATALOG = {
  facebook: { platform: "facebook", contentType: "photo_post" },
} as const;

type ChannelId = keyof typeof CHANNEL_CATALOG;

const ProductSchema = z.strictObject({
  name: z.string().trim().min(1, "Thiếu tên sản phẩm."),
  description: z.string(),
  category: z.string(),
  season: z.string(),
});

const BodySchema = z.object({
  tenantId: z.string({ error: "Thiếu mã đơn vị (tenant)." }).trim().min(1, "Thiếu mã đơn vị (tenant)."),
  product: ProductSchema,
  channels: z
    .array(z.enum(Object.keys(CHANNEL_CATALOG) as [ChannelId, ...ChannelId[]]))
    .min(1, "Chưa chọn kênh nào để viết caption."),
  postJobId: z.string().trim().min(1).optional(),
});

export const dynamic = "force-dynamic";
/** The gateway may escalate models and retry; the default budget is too tight. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    const result = await container.usecases.generateCaptions({
      tenantId: body.tenantId,
      product: body.product,
      channels: body.channels.map((channelId) => ({
        channelId,
        platform: CHANNEL_CATALOG[channelId].platform,
        contentType: CHANNEL_CATALOG[channelId].contentType,
      })),
      // TODO(E3/E4): send the cover image once the media layer can hand over
      // resized bytes (ADR-001 §4: exactly ONE cover image, never the album).
      // The web layer must not download from Drive itself.
      vision: { mode: "none" },
      postJobId: body.postJobId,
    });

    return Response.json({
      generated: result.generated.map((item) => ({
        channelId: item.channelId,
        platform: item.platform,
        text: item.caption.text,
        hashtags: item.caption.content.hashtags,
        model: item.model,
        provider: item.provider,
      })),
      // Never dropped: a channel that failed while another succeeded must still
      // be visible to the operator (business rule 5).
      failed: result.failed.map((item) => ({
        channelId: item.channelId,
        platform: item.platform,
        code: item.code,
        reason: item.reason,
      })),
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
