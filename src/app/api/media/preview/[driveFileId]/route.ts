import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * E3.6b — the SESSION-BACKED image bridge: `GET /api/media/preview/<assetId>`.
 *
 * DO NOT CONFUSE IT WITH `/api/media/[driveFileId]`. They serve the same bytes
 * to two different callers and are authorised in two completely different ways:
 *
 *   `/api/media/[driveFileId]`         tier P · public · Meta's fetcher, which
 *                                      carries no cookie · the bearer is the
 *                                      HMAC in `?sig=` · ALLOWLISTED in proxy.ts
 *   `/api/media/preview/[driveFileId]` tier R · session + membership · the
 *                                      operator's browser · the bearer is the
 *                                      session cookie · must NOT be public
 *
 * The proxy allowlist admits ONLY `/api/media/<one-segment>` (the tier-P
 * route); this path goes through the session guard like every other route —
 * and the handler still authorises itself below, because a route may never
 * assume it was reached through the guard.
 *
 * Why it exists at all: the compose screen has to SHOW the album (an operator
 * approving photos they cannot see is not approving anything), and doc 10 §2
 * forbids putting a signed link in an `<img src>` — a signed URL is a bearer
 * token, and `src=` leaks it into history, into `Referer` and into screenshots.
 * So this route mints no token: the browser already has a session.
 *
 * Consequence worth stating: unlike the tier-P link, access here ENDS the moment
 * the membership does — no 6-hour tail (doc 10 §2, Q8.6).
 *
 * Images only; a video answers 404 (the reasoning lives in the usecase).
 */

const ROUTE = "GET /api/media/preview/[driveFileId]";

/** Per-tenant bytes behind a session: never prerendered, never cached by Next. */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ driveFileId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  // Set as soon as it is known so an error log names the asset.
  let driveFileId = "";

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no session / no membership, no pixels -------------
    // Tier R: an image is post CONTENT, so every member of the tenant may see
    // it — a viewer proof-reading a draft included.
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    const params = await context.params;
    driveFileId = typeof params?.driveFileId === "string" ? params.driveFileId : "";

    // The usecase owns the rest: the tenant-scoped lookup (an asset of another
    // tenant is a 404, exactly like one that does not exist), the images-only
    // rule, the size guard and the cache-then-Drive read.
    const result = await container.usecases.getMediaPreview({
      tenantId: ctx.tenantId,
      mediaAssetId: driveFileId,
    });

    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": result.mimeType,
        "content-length": String(result.sizeBytes),
        // `private`: these bytes belong to one tenant and were released against
        // one session — no shared proxy or CDN may keep a copy of them.
        "cache-control": `private, max-age=${result.cacheSeconds}`,
        // The mime type comes from Drive; stop a browser re-interpreting it.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    // MEDIA_NOT_FOUND -> 404 · DRIVE_ERROR -> 503 · UNAUTHORIZED -> 401 ·
    // TENANT_NOT_FOUND -> 404 · FORBIDDEN -> 403, all via the shared table.
    return mapAppErrorToHttp(error, {
      logger,
      context: { route: ROUTE, drive_file_id: driveFileId || null },
    });
  }
}
