import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { OPERATOR_ROLES } from "@/shared/operator-access";

/**
 * M2.2 — invite links of the active tenant (doc 10 §4.4).
 *
 * GET  (admin, R): the list NEVER carries a token — the DB holds only hashes,
 *                  so there is nothing to leak.
 * POST (admin, S): mints the token; the RESPONSE is its one and only
 *                  appearance. The anti-escalation ladder (admin → editor/
 *                  viewer; admin/owner grants need owner) is enforced in the
 *                  usecase against the AUTHORISED role, not the body.
 */

const ROUTE_GET = "GET /api/invites";
const ROUTE_POST = "POST /api/invites";

const CreateSchema = z.object({
  role: z.enum(OPERATOR_ROLES, { error: "Vai trò của link mời không hợp lệ." }),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_GET}`,
      tier: "R",
      minRole: "admin",
    });

    const items = await container.usecases.invites.listInvites({ tenantId: ctx.tenantId });
    return Response.json({ items });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_POST}`,
      tier: "S",
      minRole: "admin",
    });

    const body = await readJsonBody(request, CreateSchema, { route: ROUTE_POST });
    const created = await container.usecases.invites.createInvite({
      tenantId: ctx.tenantId,
      inviterRole: ctx.role,
      // requireTenantContext guarantees an account-backed session.
      inviterAccountId: session.accountId ?? "",
      inviterEmail: session.email,
      role: body.role,
    });

    // The ONE appearance of the raw token, addressed to whoever created it.
    const url = `${new URL(request.url).origin}/join/${created.token}`;
    return Response.json(
      { id: created.id, role: created.role, url, expiresAt: created.expiresAt },
      { status: 201 },
    );
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_POST } });
  }
}
