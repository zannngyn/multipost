import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { buildGoogleStateCookie } from "@/app/api/catalog/google/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E2 step 1 / M1.3b — send the operator's browser to Google's consent screen.
 *
 * Tenant + role come from `requireTenantContext` (tier S, admin — connecting a
 * credential source, doc 10 §4.1), never from the query string. The state is
 * bound SERVER-SIDE: an `oauth_state` row freezes (tenant, account) at this
 * moment, and the cookie carries only the opaque nonce (doc 10 §6) — switching
 * the active tenant in another tab mid-consent cannot move the credential.
 *
 * A deployment with no Google OAuth app is NOT a 500: the usecase surfaces an
 * AppError naming the missing environment variables, and this route answers it
 * as JSON — the operator is still on the sync screen when they press the
 * button, so an error body is what they can read (doc 10 §3: `connect` keeps
 * JSON for errors on purpose).
 */

const ROUTE = "GET /api/catalog/google/connect";

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
        message: "Google connect needs a session backed by an account",
        context: { route: ROUTE },
      });
    }

    const started = await container.usecases.connectGoogleDrive.startGoogleConnect({
      tenantId: ctx.tenantId,
    });

    // Server-side binding BEFORE the browser leaves: the row is what the
    // callback will trust; the cookie below carries only the nonce.
    await container.usecases.oauthStates.issue({
      nonce: started.state,
      tenantId: ctx.tenantId,
      accountId: session.accountId,
      purpose: "google_drive",
    });

    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizeUrl,
        "set-cookie": buildGoogleStateCookie(
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
