import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { buildOauthReturnCookie } from "@/app/api/_lib/oauth-return-cookie";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { buildStateCookie } from "@/app/api/channels/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.1 step 1 / M1.3b — send the operator's browser to Facebook's OAuth
 * dialog.
 *
 * Tenant + role come from `requireTenantContext` (tier S, admin — connecting a
 * credential, doc 10 §4.2), never from the query string. The state is bound
 * SERVER-SIDE: an `oauth_state` row freezes (tenant, account) at this moment,
 * and the cookie carries only the opaque nonce (doc 10 §6).
 *
 * `?return=onboarding` is the ONLY thing the query string decides, and all it
 * decides is which of our own screens the callback lands on. It is not a URL
 * and is never echoed back — see `oauth-return-cookie.ts`.
 *
 * A Meta app that is not configured is NOT a 500: the usecase surfaces an
 * AppError naming the missing environment variables, and this route answers it
 * as JSON — the operator is still on the channels screen when they press the
 * button (doc 10 §3: `connect` keeps JSON for errors on purpose). The one
 * exception is the onboarding entry point, where a raw JSON page mid-slideshow
 * is a dead end; see the catch.
 */

const ROUTE = "GET /api/channels/connect";
/** Where the onboarding flow expects to be resumed after this round trip. */
const ONBOARDING_SCREEN = "/onboarding?step=facebook";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  const isFromOnboarding = new URL(request.url).searchParams.get("return") === "onboarding";

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge cases first: authorise before any flow starts ------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });
    if (!session.accountId) {
      // Unreachable in practice (requireTenant demands an account), belt only.
      throw new AppError("UNAUTHORIZED", {
        message: "Facebook connect needs a session backed by an account",
        context: { route: ROUTE },
      });
    }

    const started = await container.usecases.connectChannels.startFacebookConnect({
      tenantId: ctx.tenantId,
    });

    // Server-side binding BEFORE the browser leaves: the row is what the
    // callback will trust; the cookie below carries only the nonce.
    await container.usecases.oauthStates.issue({
      nonce: started.state,
      tenantId: ctx.tenantId,
      accountId: session.accountId,
      purpose: "facebook_pages",
    });

    // Secure would make the cookie invisible over plain http on a dev box,
    // and every connect would then fail with "state mismatch".
    const secure = container.config.NODE_ENV === "production";

    // `Headers` + append, NOT an object literal: an object keeps exactly one
    // `set-cookie` and the second one would vanish without a warning.
    const headers = new Headers({
      location: started.authorizeUrl,
      // The URL carries a one-time nonce; no cache, anywhere.
      "cache-control": "no-store",
    });
    headers.append("set-cookie", buildStateCookie(started.state, { secure }));
    // Set on BOTH paths on purpose. Connecting from /channels clears any return
    // cookie an abandoned onboarding attempt left behind, so "no onboarding"
    // stays "no onboarding" instead of depending on a ten-minute expiry.
    headers.append(
      "set-cookie",
      buildOauthReturnCookie(isFromOnboarding ? "onboarding" : null, { secure }),
    );

    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (isFromOnboarding) {
      // Mid-slideshow a JSON body is a dead end: the operator has no screen
      // left to read it on. Log identically, then redirect with the code so
      // the slide can say what went wrong (spec §7, §12).
      const appError = AppError.from(error, "INTERNAL", { route: ROUTE });
      logger.error("Facebook connect failed inside onboarding", {
        route: ROUTE,
        ...appError.toLogObject(),
        err: appError,
      });
      return new Response(null, {
        status: 302,
        headers: {
          location: `${ONBOARDING_SCREEN}&connect=error&reason=${encodeURIComponent(appError.code)}`,
          "cache-control": "no-store",
        },
      });
    }
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
