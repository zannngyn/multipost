import {
  ApiErrorBodySchema,
  TenantHealthSchema,
  type TenantHealth,
} from "@/ui/schemas/tenant-health.schema";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";

/**
 * Data layer for tenant screens: talks to the internal HTTP API and nothing
 * else (docs/07 §4.1). No React, no business branching — components and hooks
 * never call `fetch` themselves.
 */

/** A server request that outlives this is a server problem, not a slow network. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Query keys carry the tenant id so cached data can never leak across tenants. */
export const tenantKeys = {
  health: (tenantId: string) => ["tenant", tenantId, "health"] as const,
};

/** Combines the caller's signal with a timeout — cancel must work either way. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** A 502 from a proxy returns HTML; parsing it must not throw a raw SyntaxError. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      message: "Response body is not valid JSON",
      userMessage:
        "Máy chủ trả về dữ liệu không đọc được. Hãy thử lại; nếu vẫn lỗi, báo quản trị viên.",
      cause,
    });
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(payload);

  // The server always answers with {code, message}; anything else means a proxy
  // or a framework page answered instead — do not invent a friendly message.
  if (!parsed.success) {
    return new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status,
      message: `Unrecognised error body for HTTP ${status}`,
      userMessage: "Máy chủ trả về lỗi không xác định. Hãy thử lại sau ít phút.",
    });
  }

  return new ApiError({
    code: parsed.data.code,
    status,
    userMessage: parsed.data.message,
    message: `${parsed.data.code} (HTTP ${status})`,
    issues: parsed.data.issues,
  });
}

export async function fetchTenantHealth(
  tenantId: string,
  signal?: AbortSignal,
): Promise<TenantHealth> {
  // Guard: never send an empty query — that would be a 400 round-trip for free.
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant) để kiểm tra.",
    });
  }

  const query = new URLSearchParams({ tenantId: tenantId.trim() });

  let response: Response;
  try {
    response = await fetch(`/api/tenants/health?${query.toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Private, session-scoped data: never served from an HTTP cache.
      cache: "no-store",
      signal: withTimeout(signal),
    });
  } catch (cause) {
    const isTimeout = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ApiError({
      code: isTimeout ? CLIENT_ERROR_CODES.TIMEOUT : CLIENT_ERROR_CODES.NETWORK,
      status: 0,
      message: cause instanceof Error ? cause.message : String(cause),
      userMessage: isTimeout
        ? "Máy chủ phản hồi quá lâu. Hãy thử lại."
        : "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.",
      cause,
    });
  }

  const payload = await readJson(response);

  if (!response.ok) throw toApiError(response.status, payload);

  const parsed = TenantHealthSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      message: `Tenant health payload failed validation: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
      userMessage:
        "Dữ liệu tình trạng đơn vị không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
    });
  }

  return parsed.data;
}
