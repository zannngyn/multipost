import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { buildSupportSessionCookie } from "@/app/_lib/support-session-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { platformTenantId } from "@/composition/platform-tenant-id";

/**
 * M3.3 — `POST /api/platform/tenant-sessions`: open a support-mode visit
 * (docs/09 §3.5). `requirePlatformAdmin(support)` reads the standing FRESH;
 * the repo audits `platform.entered_tenant` UNDER THE TARGET TENANT the moment
 * the row exists — the customer's book sees the entry before the staffer sees
 * a byte of data. One visit at a time: opening a new one revokes (and books
 * the exit of) the old. No renewal endpoint exists — more time = new session
 * = new audit line.
 */

const ROUTE = "POST /api/platform/tenant-sessions";

const BodySchema = z.object({
  tenantId: uuidField("Mã công ty không hợp lệ."),
  purpose: z
    .string({ error: "Phải ghi mục đích vào hỗ trợ." })
    .trim()
    .min(10, "Phải ghi mục đích vào hỗ trợ (ít nhất 10 ký tự).")
    .max(500, "Mục đích tối đa 500 ký tự."),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Authorise the ACTOR first, fresh (tier S) --------------------------
    const session = await getOperatorSession(`api:${ROUTE}`);
    const platform = await container.usecases.requirePlatformAdmin(session, {
      minRole: "support",
    });

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const opened = await container.usecases.supportSessions.open({
      tenantId: platformTenantId(body.tenantId, { component: ROUTE }),
      purpose: body.purpose,
      accountId: platform.accountId,
      actorEmail: session?.email ?? null,
    });

    return Response.json(
      { sessionId: opened.sessionId, tenant: opened.tenant, expiresAt: opened.expiresAt },
      {
        status: 201,
        headers: {
          "set-cookie": buildSupportSessionCookie(opened.sessionId, {
            secure: container.config.NODE_ENV === "production",
          }),
        },
      },
    );
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
