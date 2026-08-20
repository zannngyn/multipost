import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { platformTenantId } from "@/composition/platform-tenant-id";

/**
 * The shared body of /suspend and /activate (M3.2): super_admin only, target
 * tenant named in the PATH — legitimate for platform APIs (doc 10 §3.5), and
 * the one place `platformTenantId` may mint the brand. The mandatory `reason`
 * (≥10 chars) is the book entry a heavy switch must carry.
 */

const BodySchema = z.object({
  reason: z
    .string({ error: "Phải ghi lý do." })
    .trim()
    .min(10, "Phải ghi lý do (ít nhất 10 ký tự) khi khoá/mở công ty."),
});

export async function handleSetTenantStatus(
  request: Request,
  params: Promise<{ tenantId: string }>,
  options: { readonly route: string; readonly status: "active" | "suspended" },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Authorise the ACTOR before touching the target ---------------------
    const session = await getOperatorSession(`api:${options.route}`);
    const platform = await container.usecases.requirePlatformAdmin(session, {
      minRole: "super_admin",
    });

    const { tenantId } = await params;
    const body = await readJsonBody(request, BodySchema, { route: options.route });

    const result = await container.usecases.platformTenants.setTenantStatus({
      tenantId: platformTenantId(tenantId, { component: options.route }),
      status: options.status,
      reason: body.reason,
      actorAccountId: platform.accountId,
      actorEmail: session?.email ?? null,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: options.route } });
  }
}
