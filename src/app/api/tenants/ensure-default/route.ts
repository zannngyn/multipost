import { getOperatorSession } from "@/app/_auth/session";
import { buildActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E10 — `POST /api/tenants/ensure-default`: make sure the signed-in account
 * has somewhere to work, then get out of the way.
 *
 * Called by the first-run gate on entry, so it is written to be safe to call
 * on EVERY entry: the usecase returns the existing company untouched when
 * there is one, and this route is idempotent in the only way that matters —
 * no second company, no surprise re-selection.
 *
 * No body: there is nothing to say. The default name lives in the usecase and
 * is changed in Cài đặt, not here.
 *
 * Deliberately NO tenant context (same stance as `POST /api/tenants`): the
 * account this serves is precisely the one that belongs nowhere yet. An
 * account-backed session is still required — a bootstrap/dev session with no
 * account row cannot own a company.
 */

const ROUTE = "POST /api/tenants/ensure-default";

export const dynamic = "force-dynamic";

export async function POST(_request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId) {
      throw new AppError("UNAUTHORIZED", {
        message: "Provisioning a default tenant requires a session backed by an account",
        context: { route: ROUTE, reason: session ? "NO_ACCOUNT" : "NO_SESSION" },
      });
    }

    const result = await container.usecases.ensureDefaultTenant({
      accountId: session.accountId,
      sessionEmail: session.email,
      displayName: session.name ?? null,
    });

    /**
     * The cookie moves ONLY for a company we just created — that operator has
     * exactly one and wants to be inside it. For an account that already
     * belonged somewhere, the selector is theirs: overwriting it here would
     * yank a multi-company operator into whichever company sorted first.
     */
    return Response.json(result, {
      status: result.wasCreated ? 201 : 200,
      headers: result.wasCreated
        ? {
            "set-cookie": buildActiveTenantCookie(result.tenantId, {
              secure: container.config.NODE_ENV === "production",
            }),
          }
        : undefined,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
