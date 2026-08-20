import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M2.2 — `DELETE /api/invites/[inviteId]`: revoke a link (admin, tier S —
 * revocation must bite fresh). Idempotent: revoking twice answers the same
 * success, an id this tenant does not hold answers INVITE_INVALID 404.
 */

const ROUTE = "DELETE /api/invites/[inviteId]";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    // --- Edge case first: a malformed id is a 400, not a Postgres cast 503 --
    const { inviteId } = await params;
    const parsed = uuidField("Mã link mời không hợp lệ.").safeParse(inviteId);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invite id in the path is not a uuid",
        userMessage: "Mã link mời không hợp lệ.",
        context: { route: ROUTE },
      });
    }

    const result = await container.usecases.invites.revokeInvite({
      tenantId: ctx.tenantId,
      id: parsed.data,
      actorAccountId: session.accountId,
      actorEmail: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
