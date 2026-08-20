import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * E2 — "đã kết nối Google chưa?" for the sync screen.
 *
 * Three states, never a token: `not_connected`, `connected` (with the account
 * e-mail, the moment and the granted scopes) and `expired` — a connection whose
 * refresh token Google rejected, which reads differently to a human than "never
 * connected" even though both end at the same button.
 *
 * Auth (M1.3b, doc 10 §4.1): viewer, tier R. The query string carries nothing
 * any more — a `tenantId` an old UI build still appends is simply not read
 * (transition rule, docs/11 §3.2).
 *
 * FIELD-LEVEL VISIBILITY (M1.4, doc 10 §4.1 + Q8.3): `state` goes to every
 * member — all three values, unabridged. A viewer watching a sync stop needs to
 * read "kết nối Google đã hết hạn" off the screen, and hiding that would only
 * turn a self-explaining screen into a support call.
 *
 * Everything else is the CREDENTIAL's identity — which Google account, what it
 * was granted, whether it can still read the source — and belongs to admin+,
 * same rule as `secretsConfigured` on the channels screen.
 *
 * The narrow answer OMITS those keys; it never sends `email: ""` or
 * `sourceAccess: null`. An empty value is indistinguishable from "nobody
 * connected an account" and would make the screen state a lie.
 */

const ROUTE = "GET /api/catalog/google/status";

/**
 * Doc 10 §1 ladder, spelled out rather than ranked: `user_role` is a closed
 * four-value enum, and `core/domain/account.roleAtLeast` is off-limits to the
 * app layer (ESLint: app may import only `@/core/domain/errors`). Same shape as
 * `canManageAccess` in `app/_auth/operator-session.ts`.
 */
function seesCredentialDetail(role: OperatorRole): boolean {
  return role === "admin" || role === "owner";
}

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no membership, no answer (doc 10 §3) --------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    const view = await container.usecases.connectGoogleDrive.getGoogleConnection({
      tenantId: ctx.tenantId,
    });

    // `state` only for viewer/editor: the e-mail, the scopes, `connectedAt`,
    // `sourceAccess` and `reason` all describe the credential itself.
    const body = seesCredentialDetail(ctx.role) ? view : { state: view.state };

    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
