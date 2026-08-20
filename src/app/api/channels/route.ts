import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { loadSecretsConfig } from "@/composition/config";
import { getContainer } from "@/composition/container";
import { roleAtLeast } from "@/composition/require-tenant";
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
 *
 * `secretsConfigured` answers a question the operator otherwise discovers the
 * hard way: without TENANT_SECRETS_ENC_KEY, READING channels works fine (the
 * box only touches the key when it meets a sealed value) while every WRITE
 * fails. The screen uses the flag to warn BEFORE the token is pasted.
 *
 * M1.3b — viewer / tier R (doc 10 §4.2); the tenant comes from the membership.
 *
 * Field-level narrowing (doc 10 Q8.3): `secretsConfigured` is a fact about OUR
 * deployment, not about the tenant's data, and only admin+ can paste a token —
 * so only admin+ needs the warning. It is OMITTED for everyone else, never sent
 * as a hard-coded `false`: a false would be a lie a viewer's screen could act
 * on ("chưa cấu hình!"), while an absent key says "not your business" and the
 * UI schema can make it optional honestly.
 */

const ROUTE = "GET /api/channels";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: viewer / tier R (doc 10 §4.2) ----------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
    });

    const channels = await container.usecases.channels.listChannels({
      tenantId: ctx.tenantId,
    });

    // Computed ONLY when it will be sent: `hasSecretsKey` logs a warning as a
    // side effect, and a viewer's list must not fill the log with a warning
    // about a key they are not being told about.
    const showSecretsFlag = roleAtLeast(ctx.role, "admin");

    return Response.json({
      tenantId: ctx.tenantId,
      channels,
      ...(showSecretsFlag ? { secretsConfigured: hasSecretsKey(logger, ctx.tenantId) } : {}),
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
