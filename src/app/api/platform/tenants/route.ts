import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { loadAppOrigin } from "@/composition/config";
import { getContainer } from "@/composition/container";

/**
 * M3.2 — platform tenant administration (doc 10 §4.4).
 *
 * GET: minRole `support` — a DELIBERATE deviation from the doc-10 matrix
 * (super_admin), decided by the orchestrator: support staff need the list to
 * enter a tenant at M3.3, and reading names/counts discloses nothing a support
 * session would not see anyway. Every MUTATION stays super_admin.
 *
 * POST: super_admin — the "khách ký hợp đồng" flow: create the tenant with NO
 * membership for the creator (MYSP staff are not members of a customer's
 * company) and hand back a single-use OWNER invite URL to send to the shop.
 * The self-service abuse caps (3/account, 1/hour) deliberately do NOT apply —
 * they are the self-service boundary, and this is the boundary's enforcer.
 */

const ROUTE_GET = "GET /api/platform/tenants";
const ROUTE_POST = "POST /api/platform/tenants";

const CreateSchema = z.object({
  name: z
    .string({ error: "Tên công ty không hợp lệ." })
    .trim()
    .min(2, "Tên công ty phải dài ít nhất 2 ký tự.")
    .max(80, "Tên công ty tối đa 80 ký tự."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, {
      error: "Định danh (slug) chỉ gồm chữ thường, số và dấu gạch ngang.",
    })
    .optional(),
  plan: z.enum(["internal", "standard"], { error: "Gói (plan) không hợp lệ." }).optional(),
});

export const dynamic = "force-dynamic";

export async function GET(_request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE_GET}`);
    await container.usecases.requirePlatformAdmin(session, { minRole: "support" });

    /**
     * The onboarding survey aggregate rides along with the rows it was counted
     * from (E10 — plan task 11). One answer, so the summary strip and the table
     * below it can never describe two different moments.
     *
     * Same `support` bar as the list itself: these are answers about how a
     * customer sells, not credentials, and they are already visible row by row
     * in the table this call feeds. Nothing here widens who may look.
     */
    const { items, surveySummary } = await container.usecases.platformTenants.listTenants();
    return Response.json({ items, surveySummary });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE_POST}`);
    const platform = await container.usecases.requirePlatformAdmin(session, {
      minRole: "super_admin",
    });

    const body = await readJsonBody(request, CreateSchema, { route: ROUTE_POST });
    const result = await container.usecases.platformTenants.createTenant({
      name: body.name,
      slug: body.slug ?? null,
      plan: body.plan ?? null,
      actorAccountId: platform.accountId,
      actorEmail: session?.email ?? null,
    });

    // The ONE appearance of the owner-invite token. Origin from AUTH_URL —
    // same rule as /api/invites: a request-built origin carries the internal
    // hop's scheme behind Caddy.
    const ownerInviteUrl = `${loadAppOrigin()}/join/${result.ownerInviteToken}`;
    return Response.json(
      {
        tenant: result.tenant,
        ownerInviteUrl,
        inviteExpiresAt: result.inviteExpiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_POST } });
  }
}
