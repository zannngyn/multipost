import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { buildActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M2.1 — `POST /api/tenants`: self-service company creation (doc 10 §4.4).
 *
 * Serves EVERY signed-in account backed by an account row — the NoMembership
 * state lands here, and an existing member may found a second company (Q1).
 * Deliberately NO tenant context: there is nothing to be a member OF yet.
 * Tier S semantics = the abuse limits are counted fresh, inside the repo's
 * transaction (docs/09 §3.7).
 *
 * The response switches the active-tenant cookie to the new company: whoever
 * just founded it wants to be inside it, not on a picker.
 */

const ROUTE = "POST /api/tenants";

const BodySchema = z.object({
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
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: an account row is the actor of everything below ---
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session || !session.accountId) {
      // Bootstrap admins without an account row land here too — consistent
      // with every tenant-scoped route since M1.3b.
      throw new AppError("UNAUTHORIZED", {
        message: "Creating a tenant requires a session backed by an account",
        context: { route: ROUTE, reason: session ? "NO_ACCOUNT" : "NO_SESSION" },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const result = await container.usecases.createTenant({
      accountId: session.accountId,
      sessionEmail: session.email,
      displayName: session.name,
      name: body.name,
      slug: body.slug ?? null,
    });

    return Response.json(result, {
      status: 201,
      headers: {
        "set-cookie": buildActiveTenantCookie(result.activeTenantId, {
          secure: container.config.NODE_ENV === "production",
        }),
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
