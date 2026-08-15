import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.1 — the Fanpage list of one tenant ("Kênh đã kết nối").
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * A tenant with no integration row answers `channels: []` with a 200: nobody
 * has connected a Page yet, which is an empty state, not a failure.
 *
 * The response never carries `accessToken` — the usecase maps to a view that
 * has no such field, so a credential cannot leak by adding a column later.
 */

const ROUTE = "GET /api/channels";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
    });

    // --- Edge case first: no tenant, no query -------------------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the channel list",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant).",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    const channels = await container.usecases.channels.listChannels({
      tenantId: parsed.data.tenantId,
    });

    return Response.json({ tenantId: parsed.data.tenantId, channels });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
