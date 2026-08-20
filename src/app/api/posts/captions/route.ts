import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { CAPTION_TONES } from "@/shared/caption-tone";

/**
 * Step 2 of the wizard: one caption per channel (E4). Thin by contract.
 *
 * Authorisation: tier **S**, minimum role **editor** (doc 10 §4.3). Tier S even
 * though no credential is touched — the call spends real money that cannot be
 * refunded, and the per-day ceiling is still not wired (doc 10 B1), so the
 * damage a revoked operator can do inside a 60s cache window has no upper
 * bound. The fresh membership read costs ~1ms against a 5–30s AI call.
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

/**
 * Neither the tenant nor the post job is taken from the caller any more.
 *
 * `tenantId` (M1.3b): comes from `requireTenantContext()`. A field an old client
 * still sends is stripped by this non-strict object — transition rule, docs/11
 * §3.2; M1.4 removes it from the UI.
 *
 * `postJobId` (doc 10 B2): used to travel straight into the log context and the
 * `ai_generation` row without ever being checked against the tenant, so any
 * signed-in operator could staple their generation onto another tenant's job id.
 * No caller in the repo sends it (`ui/services/post.api.ts` never has), so the
 * field is REMOVED rather than validated — a field that does not exist cannot be
 * forged. TODO(B2): when the wizard does need caption↔post_job linkage, resolve
 * it server-side via `postJobs.findJobById(ctx.tenantId, id)` and answer 404 for
 * a job outside the tenant; that needs a `POST_JOB_NOT_FOUND` code, which
 * `errors.ts` does not have yet.
 */
const BodySchema = z.object({
  product: ProductSchema,
  channels: z
    .array(z.enum(Object.keys(CHANNEL_CATALOG) as [ChannelId, ...ChannelId[]]))
    .min(1, "Chưa chọn kênh nào để viết caption."),
  /**
   * Tone dropdown of the compose form. A CLOSED enum, never free text: the
   * client picks a key, the Vietnamese sentence it maps to lives server-side in
   * `shared/caption-tone` (ADR-001 — a client must not be able to write part of
   * a prompt). Absent = `mac-dinh` = today's prompt, unchanged.
   */
  tone: z.enum(CAPTION_TONES, { error: "Tông giọng không hợp lệ." }).optional(),
});

export const dynamic = "force-dynamic";
/** The gateway may escalate models and retry; the default budget is too tight. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: authorise before spending a cent (doc 10 §4.3) -----
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "editor",
    });

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    const result = await container.usecases.generateCaptions({
      tenantId: ctx.tenantId,
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
      // Omitted entirely when the client sent nothing, so the usecase sees the
      // same input it saw before tones existed.
      ...(body.tone ? { tone: body.tone } : {}),
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
