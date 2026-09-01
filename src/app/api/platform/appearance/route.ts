import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { APPEARANCE_PRESET_IDS } from "@/shared/appearance-presets";

/**
 * M3.4 — the colour of the product, set by MYSP staff for every company at once.
 *
 * GET: minRole `support` — the same deviation the tenant list makes, for the
 * same reason: support staff open the platform screens, and the name of a
 * colour discloses nothing. The value is on every page they can already see.
 *
 * PUT: `super_admin` — repainting the product for every customer at once is a
 * platform-wide act, and the ladder for those is super_admin without exception.
 *
 * PUT, not POST: this is one named setting being replaced, and replacing it
 * twice with the same id must be the same as doing it once (the usecase already
 * answers `already` rather than writing again).
 *
 * NOT the read path for rendering. Pages get the preset from the container in
 * the root layout — a fetch to our own route would add a hop to every request
 * and could not run before first paint anyway.
 */

const ROUTE_GET = "GET /api/platform/appearance";
const ROUTE_PUT = "PUT /api/platform/appearance";

/**
 * The enum is built from the preset table, so a preset added there is accepted
 * here without anybody remembering to widen a second list. The usecase
 * validates again — this is the boundary check, not the authority.
 */
const UpdateSchema = z.object({
  presetId: z.enum(APPEARANCE_PRESET_IDS as unknown as [string, ...string[]], {
    error: "Bộ màu không hợp lệ.",
  }),
});

export const dynamic = "force-dynamic";

export async function GET(_request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE_GET}`);
    await container.usecases.requirePlatformAdmin(session, { minRole: "support" });

    const settings = await container.usecases.platformAppearance.get();
    return Response.json(settings);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function PUT(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const session = await getOperatorSession(`api:${ROUTE_PUT}`);
    const platform = await container.usecases.requirePlatformAdmin(session, {
      minRole: "super_admin",
    });

    const body = await readJsonBody(request, UpdateSchema, { route: ROUTE_PUT });
    const result = await container.usecases.platformAppearance.set({
      presetId: body.presetId,
      actorAccountId: platform.accountId,
      actorEmail: session?.email ?? null,
    });

    return Response.json({ presetId: result.presetId, already: result.already });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}
