import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readTarget } from "@/app/api/prompts/_lib/prompt-route";
import { getContainer } from "@/composition/container";

/**
 * E10.7 — what a generation would use RIGHT NOW: the tenant's active version,
 * or the built-in template when the tenant has none of its own.
 *
 * Separate from `GET /api/prompts` on purpose: the screen shows "đang dùng"
 * prominently, and after an activation it must be able to re-read that single
 * fact without pulling the whole version list.
 */

const ROUTE = "GET /api/prompts/active";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const target = readTarget(request, ROUTE);
    const template = await container.usecases.promptTemplates.getActive(target);

    return Response.json(template);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
