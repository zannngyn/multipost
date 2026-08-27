import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { type ErrorLogger } from "@/app/api/_lib/http-errors";
import { buildOauthReturnCookie, resolveReturnScreen } from "@/app/api/_lib/oauth-return-cookie";
import {
  clearGoogleStateCookie,
  readGoogleStateCookie,
} from "@/app/api/catalog/google/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E2 step 2 / M1.3b — Google sends the operator's BROWSER back here.
 *
 * Everything the callback trusts comes from the SERVER-SIDE state row the
 * cookie nonce points at (doc 10 §6):
 *   1. claim the nonce — single-use, marked used BEFORE any external call;
 *   2. the row names tenant + account frozen at flow START — the active-tenant
 *      cookie is ignored, so switching companies in another tab mid-consent
 *      cannot move the credential;
 *   3. the row proves "same browser, same person"; it does NOT prove "still
 *      allowed" — the CURRENT session's role is re-checked fresh
 *      (requireTenant tier S, admin) before anything is written.
 * Any mismatch → 302 `?google=error&reason=STATE_MISMATCH`.
 *
 * This route never answers JSON: whatever happens, the browser must land on a
 * screen with a message it can show. WHICH screen is decided by
 * `resolveReturnScreen` — `/sync` for every historic entry point, the
 * onboarding slide when the connect started there. Every exit runs through the
 * one `redirect` helper below, so no branch (cancel included) can quietly keep
 * the old destination. The state cookie is cleared on EVERY exit — a nonce that
 * survives a failed attempt can be replayed.
 */

const ROUTE = "GET /api/catalog/google/callback";
/** Unchanged for everyone who did not arrive through the onboarding flow. */
const SCREEN = "/sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  const url = new URL(request.url);
  let secure = url.protocol === "https:";

  try {
    const container = getContainer();
    logger = container.logger;
    secure = container.config.NODE_ENV === "production";

    const nonce = readGoogleStateCookie(request);

    // --- Edge case first: the operator declined ------------------------------
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      // access_denied is a CHOICE, not a failure: log it as such and go back.
      logger.warn("Google Drive connect was declined", {
        route: ROUTE,
        oauth_error: oauthError,
        error_code: "CONNECT_CANCELLED",
      });
      return redirect(request, url, "google=cancelled", secure);
    }

    if (!nonce) {
      logger.warn("Google callback arrived without a usable state cookie", {
        route: ROUTE,
        error_code: "GOOGLE_CONNECT_STATE_INVALID",
        reason: "STATE_COOKIE_ABSENT",
      });
      return redirect(request, url, "google=error&reason=STATE_MISMATCH", secure);
    }

    // Single-use claim — the row is burned HERE, before any external call, so
    // a replayed callback (or a race of two) finds nothing to spend.
    const claimed = await container.usecases.oauthStates.claim(nonce, "google_drive");
    if (!claimed) {
      logger.warn("Google callback state could not be claimed", {
        route: ROUTE,
        error_code: "GOOGLE_CONNECT_STATE_INVALID",
        reason: "STATE_CLAIM_REFUSED",
      });
      return redirect(request, url, "google=error&reason=STATE_MISMATCH", secure);
    }

    /**
     * The row proves the browser; the SESSION must prove the person is still
     * who started the flow AND still an admin of that tenant (fresh, tier S):
     * a role revoked mid-consent must bite here, not after the write.
     */
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId || session.accountId !== claimed.accountId) {
      logger.warn("Google callback session does not match the flow starter", {
        route: ROUTE,
        tenant_id: claimed.tenantId,
        error_code: "UNAUTHORIZED",
        reason: "STATE_ACCOUNT_MISMATCH",
        alert: "OPERATOR_ATTENTION",
      });
      return redirect(request, url, "google=error&reason=STATE_MISMATCH", secure);
    }
    // Throws TENANT_NOT_FOUND / FORBIDDEN when the membership or role is gone.
    const ctx = await container.usecases.requireTenant(session, claimed.tenantId, {
      tier: "S",
      minRole: "admin",
    });

    await container.usecases.connectGoogleDrive.completeGoogleConnect({
      tenantId: ctx.tenantId,
      code: url.searchParams.get("code") ?? "",
      // Both still checked in the usecase (constant-time): the query state must
      // equal the cookie nonce, or the round trip was stitched together.
      state: url.searchParams.get("state") ?? "",
      expectedState: nonce,
      actorEmail: session.email,
    });

    return redirect(request, url, "google=connected", secure);
  } catch (error) {
    // The browser is mid-navigation: an error BODY would be a dead end. Log with
    // full context here (this is where the error stops), redirect with the code.
    const appError = AppError.from(error, "INTERNAL", { route: ROUTE });
    logger.error("Google Drive connect callback failed", {
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
    return redirect(request, url, `google=error&reason=${encodeURIComponent(reason)}`, secure);
  }
}

/**
 * The single exit of this route: 302 back to whichever screen started the flow,
 * always clearing both one-time cookies.
 *
 * Routing through one helper is deliberate. The bug this mechanism exists to
 * prevent is a branch — cancel, state mismatch — that still hardcodes `/sync`
 * and drops the operator out of the slideshow. With one exit there is no branch
 * left to forget.
 */
function redirect(request: Request, current: URL, query: string, secure: boolean): Response {
  const target = resolveReturnScreen({
    request,
    defaultScreen: SCREEN,
    onboardingStep: "data",
    query,
  });
  const headers = new Headers({
    location: new URL(target, current.origin).toString(),
    "cache-control": "no-store",
  });
  // Two cookies, so `Headers.append` — an object literal would keep only one.
  headers.append("set-cookie", clearGoogleStateCookie({ secure }));
  // Cleared even when it was never set: a stale return flag would otherwise
  // pull the NEXT connect, started from /sync, back into onboarding.
  headers.append("set-cookie", buildOauthReturnCookie(null, { secure }));
  return new Response(null, { status: 302, headers });
}
