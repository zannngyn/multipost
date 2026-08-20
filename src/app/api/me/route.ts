import { getOperatorSession } from "@/app/_auth/session";
import { readActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { readSupportSessionCookie } from "@/app/_lib/support-session-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M1.2 — `GET /api/me`: account + companies + active tenant (doc 10 §4.4).
 * Serves EVERY signed-in state, including NoMembership (`tenants: []`) and a
 * bootstrap/dev session with no account row (`account: null`) — the UI decides
 * between picker, create-or-join and the app shell from this one answer.
 * Thin by contract (docs/07 §3.3).
 */

const ROUTE = "GET /api/me";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first ----------------------------------------------------
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session) {
      throw new AppError("UNAUTHORIZED", {
        message: "GET /api/me requires a signed-in operator",
        context: { route: ROUTE },
      });
    }

    const overview = await container.usecases.getOperatorOverview({
      sessionEmail: session.email,
      // From the env check the session already carried out — the UI uses it to
      // tell a bootstrap admin from a genuinely new person (both may have
      // `account: null, tenants: []`).
      isBootstrapAdmin: session.isBootstrapAdmin,
      cookieTenantId: readActiveTenantCookie(request),
    });

    /**
     * M3.3 — a live support visit rides on top of the overview: the UI draws
     * the "đang hỗ trợ tenant X" banner from `supportSession`, and
     * `activeTenantId` points at the VISITED tenant so the ordinary R routes
     * read its data. The peek is a fresh row check — an expired/revoked visit
     * simply reads as null and the overview stands untouched.
     */
    const support = await container.usecases.supportSessions.peek(
      readSupportSessionCookie(request),
      session.accountId,
    );

    return Response.json({
      ...overview,
      supportSession: support
        ? {
            tenantId: support.tenantId,
            tenantName: support.tenantName,
            expiresAt: support.expiresAt,
          }
        : null,
      activeTenantId: support ? support.tenantId : overview.activeTenantId,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
