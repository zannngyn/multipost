import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
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
 * A Meta app that is not configured is NOT a 500: the usecase surfaces an
 * AppError naming the missing environment variables, and this route answers it
 * as JSON — the operator is still on the channels screen when they press the
 * button (doc 10 §3: `connect` keeps JSON for errors on purpose).
 */

const ROUTE = "GET /api/channels/connect";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

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

    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizeUrl,
        "set-cookie": buildStateCookie(
          started.state,
          // Secure would make the cookie invisible over plain http on a dev box,
          // and every connect would then fail with "state mismatch".
          { secure: container.config.NODE_ENV === "production" },
        ),
        // The URL carries a one-time nonce; no cache, anywhere.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
