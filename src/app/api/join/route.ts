import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { buildActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M2.2 — `POST /api/join`: redeem an invite token (doc 10 §4.4).
 *
 * Serves the NoMembership state, so deliberately NO tenant context: the tenant
 * comes out of the INVITE row (same stance as the OAuth-state callback). Every
 * refusal is ONE 404 INVITE_INVALID — /join must not be a probing oracle.
 *
 * Success switches the active-tenant cookie to the joined company, including
 * the `alreadyMember` no-op: whoever clicks a company's link wants to be there.
 */

const ROUTE = "POST /api/join";

/**
 * Deliberately NO shape/length rule here: a 400 for "wrong shape" next to a
 * 404 for "wrong token" would tell a prober whether their guess LOOKS right —
 * the exact oracle INVITE_INVALID exists to prevent. The schema only demands
 * "a string is present" (a missing field is a malformed request, not a token
 * probe); every judgement about the value lives in the usecase → one 404.
 */
const BodySchema = z.object({
  token: z.string({ error: "Thiếu mã mời." }),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first ----------------------------------------------------
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId) {
      throw new AppError("UNAUTHORIZED", {
        message: "Joining a tenant requires a session backed by an account",
        context: { route: ROUTE, reason: session ? "NO_ACCOUNT" : "NO_SESSION" },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const result = await container.usecases.joinWithInvite({
      accountId: session.accountId,
      sessionEmail: session.email,
      displayName: session.name,
      token: body.token,
    });

    return Response.json(result, {
      headers: {
        "set-cookie": buildActiveTenantCookie(result.tenant.id, {
          secure: container.config.NODE_ENV === "production",
        }),
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
