import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { type ErrorLogger } from "@/app/api/_lib/http-errors";
import { clearStateCookie, readStateCookie } from "@/app/api/channels/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E5.1 step 2 — Facebook sends the operator's BROWSER back here.
 *
 * This route never answers JSON: whatever happens, the browser must land on the
 * channels screen with a message it can show. Three exits:
 *   ?connected=<n>&new=<n>&skipped=<n>
 *                             — n Pages saved, of which `new` are new, and
 *                               `skipped` were listed without a usable token
 *   ?connect=cancelled        — the operator pressed "Huỷ" (a normal outcome,
 *                               Facebook says error=access_denied; NOT a 500)
 *   ?connect=error&reason=... — anything else, with the AppError code as reason
 *
 * The state cookie is cleared on EVERY exit, including the error ones: a nonce
 * that survives a failed attempt is a nonce that can be replayed.
 */

const ROUTE = "GET /api/channels/callback";
const SCREEN = "/channels";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  const url = new URL(request.url);
  let secure = url.protocol === "https:";

  try {
    const container = getContainer();
    logger = container.logger;
    secure = container.config.NODE_ENV === "production";

    const cookie = readStateCookie(request);
    if (cookie.kind === "malformed") {
      logger.warn("Facebook callback carried an unreadable state cookie", {
        route: ROUTE,
        reason: "STATE_COOKIE_MALFORMED",
      });
    }
    const payload = cookie.kind === "present" ? cookie.payload : null;

    // --- Edge case first: the operator declined ------------------------------
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      // access_denied is a CHOICE, not a failure: log it as such and go back.
      logger.warn("Facebook connect was declined", {
        route: ROUTE,
        tenant_id: payload?.tenantId ?? null,
        oauth_error: oauthError,
        oauth_error_reason: url.searchParams.get("error_reason"),
        error_code: "CONNECT_CANCELLED",
      });
      return redirect(url, `${SCREEN}?connect=cancelled`, secure);
    }

    // The browser arrives with its session cookie (this path is behind the
    // guard), so the audit row names the operator here exactly like the
    // paste-a-token door does.
    const session = await getOperatorSession(`api:${ROUTE}`);

    const result = await container.usecases.connectChannels.completeFacebookConnect({
      // From the cookie, never from the query string: a tenant id in a URL is
      // an invitation to write into someone else's tenant.
      tenantId: legacyTenantIdFromRequest(payload?.tenantId) ?? "",
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
      expectedState: payload?.state ?? "",
      actorEmail: session?.email ?? null,
    });

    // `skipped` travels too: a Page Facebook listed without a token was NOT
    // saved, and "vì sao Page X không có trong danh sách" must be answerable on
    // this door as well, not only on the paste-a-token one (business rule 5).
    return redirect(
      url,
      `${SCREEN}?connected=${result.imported + result.updated}&new=${result.imported}` +
        `&skipped=${result.skipped}`,
      secure,
    );
  } catch (error) {
    // The browser is mid-navigation: an error BODY would be a dead end. Log with
    // full context here (this is where the error stops), redirect with the code.
    const appError = AppError.from(error, "INTERNAL", { route: ROUTE });
    logger.error("Facebook connect callback failed", {
      route: ROUTE,
      ...appError.toLogObject(),
      err: appError,
    });
    return redirect(
      url,
      `${SCREEN}?connect=error&reason=${encodeURIComponent(appError.code)}`,
      secure,
    );
  }
}

/** 302 back to the screen, always clearing the one-time state cookie. */
function redirect(current: URL, target: string, secure: boolean): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL(target, current.origin).toString(),
      "set-cookie": clearStateCookie({ secure }),
      "cache-control": "no-store",
    },
  });
}
