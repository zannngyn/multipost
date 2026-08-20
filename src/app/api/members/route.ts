import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * M2.3 — `GET /api/members` (admin, R): the ACTIVE members of the working
 * company. `email` is the identity's ATTRIBUTE address (nullable — Facebook may
 * have none); the session key never leaves the server. `isYou` lets the UI stop
 * an admin from demoting/removing themselves by accident.
 */

const ROUTE = "GET /api/members";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "admin",
    });

    const items = await container.usecases.members.listMembers({
      tenantId: ctx.tenantId,
      actorAccountId: session.accountId,
    });

    return Response.json({ items });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
