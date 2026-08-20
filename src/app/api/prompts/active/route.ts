import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { readTarget } from "@/app/api/prompts/_lib/prompt-route";
import { getContainer } from "@/composition/container";

/**
 * E10.7 — what a generation would use RIGHT NOW: the tenant's active version,
 * or the built-in template when the tenant has none of its own.
 *
 * Separate from `GET /api/prompts` on purpose: the screen shows "đang dùng"
 * prominently, and after an activation it must be able to re-read that single
 * fact without pulling the whole version list.
 *
 * Authorisation: tier R, minimum role **editor** (doc 10 §4.3). It returns the
 * same full `systemPrompt`/`body` as the list, so a lower bar here would make
 * the bar on `GET /api/prompts` meaningless.
 */

const ROUTE = "GET /api/prompts/active";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "editor",
    });

    const target = readTarget(request, ROUTE);
    const template = await container.usecases.promptTemplates.getActive({
      tenantId: ctx.tenantId,
      ...target,
    });

    return Response.json(template);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
