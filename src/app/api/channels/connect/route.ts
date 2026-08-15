import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { buildStateCookie } from "@/app/api/channels/_lib/oauth-state-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.1 step 1 — send the operator's browser to Facebook's OAuth dialog.
 *
 * Answers a 302, not JSON: the browser is navigating. The CSRF nonce goes out
 * in an httpOnly cookie (see _lib/oauth-state-cookie) AND in the `state`
 * parameter; /callback only proceeds when the two match.
 *
 * A Meta app that is not configured is NOT a 500: the usecase surfaces an
 * AppError naming the missing environment variables, and this route answers it
 * as JSON — the operator is still on the channels screen when they press the
 * button, so an error body is what they can read.
 */

const ROUTE = "GET /api/channels/connect";

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

    // --- Edge case first: never start a flow we cannot finish ---------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the Facebook connect flow",
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

    const started = await container.usecases.connectChannels.startFacebookConnect({
      tenantId: parsed.data.tenantId,
    });

    return new Response(null, {
      status: 302,
      headers: {
        location: started.authorizeUrl,
        "set-cookie": buildStateCookie(
          { state: started.state, tenantId: started.tenantId },
          // Secure would make the cookie invisible over plain http on a dev box,
          // and every connect would then fail with "state mismatch".
          { secure: container.config.NODE_ENV === "production" },
        ),
        // The URL carries a one-time nonce; no cache, anywhere.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
