import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { type ErrorLogger } from "@/app/api/_lib/http-errors";
import { clearStateCookie, readStateCookie } from "@/app/api/channels/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.1 step 2 / M1.3b — Facebook sends the operator's BROWSER back here.
 *
 * Everything the callback trusts comes from the SERVER-SIDE state row the
 * cookie nonce points at (doc 10 §6):
 *   1. claim the nonce — single-use, marked used BEFORE any external call;
 *   2. the row names tenant + account frozen at flow START — a mid-consent
 *      company switch in another tab cannot move the Page tokens;
 *   3. the CURRENT session must be the same person AND still an admin of that
 *      tenant (fresh, tier S) before anything is written.
 * Any mismatch → 302 `?connect=error&reason=STATE_MISMATCH`.
 *
 * This route never answers JSON: whatever happens, the browser must land on
 * the channels screen with a message it can show. The state cookie is cleared
 * on EVERY exit — a nonce that survives a failed attempt can be replayed.
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

    const nonce = readStateCookie(request);

    // --- Edge case first: the operator declined ------------------------------
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      // access_denied is a CHOICE, not a failure: log it as such and go back.
      logger.warn("Facebook connect was declined", {
        route: ROUTE,
        oauth_error: oauthError,
        oauth_error_reason: url.searchParams.get("error_reason"),
        error_code: "CONNECT_CANCELLED",
      });
      return redirect(url, `${SCREEN}?connect=cancelled`, secure);
    }

    if (!nonce) {
      logger.warn("Facebook callback arrived without a usable state cookie", {
        route: ROUTE,
        error_code: "UNAUTHORIZED",
        reason: "STATE_COOKIE_ABSENT",
      });
      return redirect(url, `${SCREEN}?connect=error&reason=STATE_MISMATCH`, secure);
    }

    // Single-use claim — the row is burned HERE, before any external call, so
    // a replayed callback (or a race of two) finds nothing to spend.
    const claimed = await container.usecases.oauthStates.claim(nonce, "facebook_pages");
    if (!claimed) {
      logger.warn("Facebook callback state could not be claimed", {
        route: ROUTE,
        error_code: "UNAUTHORIZED",
        reason: "STATE_CLAIM_REFUSED",
      });
      return redirect(url, `${SCREEN}?connect=error&reason=STATE_MISMATCH`, secure);
    }

    /**
     * The row proves the browser; the SESSION must prove the person is still
     * who started the flow AND still an admin of that tenant (fresh, tier S):
     * a role revoked mid-consent must bite here, not after the write.
     */
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId || session.accountId !== claimed.accountId) {
      logger.warn("Facebook callback session does not match the flow starter", {
        route: ROUTE,
        tenant_id: claimed.tenantId,
        error_code: "UNAUTHORIZED",
        reason: "STATE_ACCOUNT_MISMATCH",
        alert: "OPERATOR_ATTENTION",
      });
      return redirect(url, `${SCREEN}?connect=error&reason=STATE_MISMATCH`, secure);
    }
    // Throws TENANT_NOT_FOUND / FORBIDDEN when the membership or role is gone.
    const ctx = await container.usecases.requireTenant(session, claimed.tenantId, {
      tier: "S",
      minRole: "admin",
    });

    const result = await container.usecases.connectChannels.completeFacebookConnect({
      tenantId: ctx.tenantId,
      code: url.searchParams.get("code") ?? "",
      // Both still checked in the usecase (constant-time): the query state must
      // equal the cookie nonce, or the round trip was stitched together.
      state: url.searchParams.get("state") ?? "",
      expectedState: nonce,
      actorEmail: session.email,
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
    // Authorisation refusals collapse into STATE_MISMATCH: the flow must be
    // restarted either way, and the reason must not leak what exists.
    const reason =
      appError.code === "TENANT_NOT_FOUND" || appError.code === "FORBIDDEN"
        ? "STATE_MISMATCH"
        : appError.code;
    return redirect(url, `${SCREEN}?connect=error&reason=${encodeURIComponent(reason)}`, secure);
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
