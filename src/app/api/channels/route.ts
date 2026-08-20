import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { loadSecretsConfig } from "@/composition/config";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E5.1 — the Fanpage list of one tenant ("Kênh đã kết nối").
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * A tenant with no integration row answers `channels: []` with a 200: nobody
 * has connected a Page yet, which is an empty state, not a failure.
 *
 * The response never carries `accessToken` — the usecase maps to a view that
 * has no such field, so a credential cannot leak by adding a column later.
 *
 * `secretsConfigured` answers a question the operator otherwise discovers the
 * hard way: without TENANT_SECRETS_ENC_KEY, READING channels works fine (the
 * box only touches the key when it meets a sealed value) while every WRITE
 * fails. The screen uses the flag to warn BEFORE the token is pasted.
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
      tenantId: legacyTenantIdFromRequest(parsed.data.tenantId),
    });

    return Response.json({
      tenantId: parsed.data.tenantId,
      channels,
      secretsConfigured: hasSecretsKey(logger, parsed.data.tenantId),
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}

/**
 * Whether this process can seal a credential. Deliberately NOT fatal: config.ts
 * loads this group on demand precisely so a process that never touches a secret
 * still boots (and so `next build` does not need the key). The missing key is
 * reported as a flag + a warning, never as a failed list.
 */
function hasSecretsKey(logger: ErrorLogger, tenantId: string): boolean {
  try {
    loadSecretsConfig();
    return true;
  } catch (error) {
    // Logged with context, not swallowed: this is the answer to "vì sao bấm
    // Kết nối lại báo lỗi 400 mà danh sách vẫn hiện".
    logger.warn("TENANT_SECRETS_ENC_KEY is missing — connecting a channel will fail", {
      route: ROUTE,
      tenant_id: tenantId,
      error_code: AppError.is(error) ? error.code : "INTERNAL",
      reason: "SECRETS_KEY_MISSING",
    });
    return false;
  }
}
