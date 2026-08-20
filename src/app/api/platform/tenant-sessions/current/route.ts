import { getOperatorSession } from "@/app/_auth/session";
import {
  clearSupportSessionCookie,
  readSupportSessionCookie,
} from "@/app/_lib/support-session-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M3.3 — `DELETE /api/platform/tenant-sessions/current`: leave the visited
 * tenant. Idempotent (no cookie / already closed → same success), audits
 * `platform.exited_tenant` exactly once, clears the cookie on EVERY exit.
 *
 * Deliberately NOT behind `requirePlatformAdmin`: leaving must work for a
 * staffer whose platform role was just revoked mid-visit — the one person we
 * most want out. The repo only revokes rows OWNED by the session's account,
 * so nobody can close somebody else's visit.
 */

const ROUTE = "DELETE /api/platform/tenant-sessions/current";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId) {
      throw new AppError("UNAUTHORIZED", {
        message: "Closing a support session requires a signed-in account",
        context: { route: ROUTE },
      });
    }

    const result = await container.usecases.supportSessions.close({
      sessionId: readSupportSessionCookie(request),
      accountId: session.accountId,
      actorEmail: session.email,
    });

    return Response.json(result, {
      headers: {
        "set-cookie": clearSupportSessionCookie({
          secure: container.config.NODE_ENV === "production",
        }),
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
