import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { OPERATOR_ROLES } from "@/shared/operator-access";

/**
 * M2.3 — one member of the working company (admin, tier S — membership changes
 * are authorisation changes).
 *
 * PUT    {role} — the ladder (admin never touches admin/owner, never promotes
 *                 past editor; owner does everything) and the LAST_OWNER rule
 *                 are enforced transactionally in the repo, against the
 *                 target's CURRENT role.
 * DELETE        — remove (status='removed', revivable through an invite).
 *                 Removing yourself = leaving the company, allowed — except
 *                 for the last owner.
 */

const ROUTE_PUT = "PUT /api/members/[membershipId]";
const ROUTE_DELETE = "DELETE /api/members/[membershipId]";

const RoleSchema = z.object({
  role: z.enum(OPERATOR_ROLES, { error: "Vai trò không hợp lệ." }),
});

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ membershipId: string }> };

async function parseMembershipId(params: RouteParams["params"], route: string): Promise<string> {
  const { membershipId } = await params;
  const parsed = uuidField("Mã thành viên không hợp lệ.").safeParse(membershipId);
  if (!parsed.success) {
    // A malformed id is the CALLER's 400, not a Postgres cast 503.
    throw new AppError("INVALID_INPUT", {
      message: "Membership id in the path is not a uuid",
      userMessage: "Mã thành viên không hợp lệ.",
      context: { route },
    });
  }
  return parsed.data;
}

export async function PUT(request: Request, { params }: RouteParams): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "S",
      minRole: "admin",
    });
    const membershipId = await parseMembershipId(params, ROUTE_PUT);
    const body = await readJsonBody(request, RoleSchema, { route: ROUTE_PUT });

    const result = await container.usecases.members.changeRole({
      tenantId: ctx.tenantId,
      membershipId,
      role: body.role,
      // The ladder judges the AUTHORISED role, never anything from the client.
      actorRole: ctx.role,
      actorAccountId: session.accountId ?? "",
      actorEmail: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_DELETE}`,
      tier: "S",
      minRole: "admin",
    });
    const membershipId = await parseMembershipId(params, ROUTE_DELETE);

    const result = await container.usecases.members.removeMember({
      tenantId: ctx.tenantId,
      membershipId,
      actorRole: ctx.role,
      actorAccountId: session.accountId ?? "",
      actorEmail: session.email,
    });

    return Response.json({ ...result, removed: true });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
