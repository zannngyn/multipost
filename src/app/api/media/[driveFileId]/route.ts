import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer, MEDIA_QUERY_PARAMS } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E3.6 — the PUBLIC media bridge: `GET /api/media/<driveFileId>?tenant=&expires=&sig=`.
 *
 * Public on purpose (allowlisted in `middleware.ts`): Graph API fetches the
 * photo itself and Meta's fetcher carries no session cookie. The bearer here is
 * the HMAC signature minted by `signMediaUrl`, not the operator session.
 *
 * Thin by contract (docs/07 §3.3): read three query params, hand them to
 * `getMediaContent`, stream the bytes back.
 *
 * NO zod layer on the query string — deliberate, and the one place in this repo
 * where "validate at the boundary" is delegated: the usecase answers a single
 * UNAUTHORIZED for every rejection (missing param, malformed claims, bad MAC,
 * expired) so this endpoint cannot be used as an oracle. A 400 for "missing
 * sig" versus a 401 for "wrong sig" would tell an attacker which half of the
 * link they got right.
 *
 * The signature is never logged, never echoed and never part of an error body.
 */

const ROUTE = "GET /api/media/[driveFileId]";

/** Signed, per-tenant bytes: never prerendered, never cached by Next. */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ driveFileId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  // Set as soon as it is known so the error log names the asset, not the link.
  let driveFileId = "";

  try {
    const container = getContainer();
    logger = container.logger;

    const params = await context.params;
    driveFileId = typeof params?.driveFileId === "string" ? params.driveFileId : "";
    const query = new URL(request.url).searchParams;

    const result = await container.usecases.getMediaContent({
      tenantId: legacyTenantIdFromRequest(query.get(MEDIA_QUERY_PARAMS.tenant) ?? ""),
      mediaAssetId: driveFileId,
      expiresAt: query.get(MEDIA_QUERY_PARAMS.expires) ?? "",
      signature: query.get(MEDIA_QUERY_PARAMS.signature) ?? "",
    });

    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": result.mimeType,
        "content-length": String(result.sizeBytes),
        // `private`: a signed link is a bearer token — no shared proxy may keep
        // a copy that outlives the signature.
        "cache-control": `private, max-age=${result.cacheSeconds}`,
        // The mime type comes from Drive; stop a browser from re-interpreting it.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    // UNAUTHORIZED -> 401 · MEDIA_NOT_FOUND -> 404 · DRIVE_ERROR -> 503, all via
    // the shared table. `drive_file_id` is safe context; the query string is not.
    return mapAppErrorToHttp(error, {
      logger,
      context: { route: ROUTE, drive_file_id: driveFileId || null },
    });
  }
}
