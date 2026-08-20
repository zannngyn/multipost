import {
  CreatePlatformTenantResponseSchema,
  EndSupportSessionResponseSchema,
  PlatformTenantListResponseSchema,
  PlatformTenantMutationResponseSchema,
  StartSupportSessionResponseSchema,
  type CreatePlatformTenantFormValues,
  type CreatePlatformTenantResponse,
  type PlatformTenantListResponse,
  type StartSupportSessionResponse,
} from "@/ui/schemas/platform.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the platform admin screen (M3.2), docs/07 §4.1.
 *   GET  /api/platform/tenants                  every company MYSP operates
 *   POST /api/platform/tenants                  create one for a customer
 *   POST /api/platform/tenants/:id/suspend      take one offline (with a reason)
 *   POST /api/platform/tenants/:id/activate     put it back
 *
 * Deliberately NOT tenant-scoped: a platform admin may hold no membership at
 * all, so a company is addressed by id here and the active-tenant cookie plays
 * no part.
 *
 * Nothing fails soft: a suspend that did not land must never look like it did —
 * somebody would stop chasing an incident that is still live.
 */

export const platformKeys = {
  /** No tenant segment: this list belongs to the ACCOUNT, not to a company. */
  tenants: () => ["platform", "tenants"] as const,
};

function requireTenantId(tenantId: string): string {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Thiếu mã công ty.",
    });
  }
  return trimmed;
}

export async function listPlatformTenants(
  signal?: AbortSignal,
): Promise<PlatformTenantListResponse> {
  return apiRequest("/api/platform/tenants", {
    schema: PlatformTenantListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách công ty không đúng định dạng. Hãy báo quản trị hệ thống kiểm tra máy chủ.",
  });
}

/** Never auto-retried: a second call creates a SECOND company for the customer. */
export async function createPlatformTenant(
  values: CreatePlatformTenantFormValues,
  signal?: AbortSignal,
): Promise<CreatePlatformTenantResponse> {
  const name = values.name?.trim() ?? "";
  const slug = values.slug?.trim().toLowerCase() ?? "";
  const plan = values.plan?.trim() ?? "";

  // Guard: a round trip would only return the same 400 we can raise here.
  if (name.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "createPlatformTenant requires a name",
      userMessage: "Nhập tên công ty trước khi tạo.",
      issues: [{ path: "name", message: "Nhập tên công ty trước khi tạo." }],
    });
  }

  return apiRequest("/api/platform/tenants", {
    method: "POST",
    // Optional fields are left OUT when empty rather than sent as "", which the
    // server would have to reject — the defaults are its business.
    body: {
      name,
      ...(slug.length > 0 ? { slug } : {}),
      ...(plan.length > 0 ? { plan } : {}),
    },
    schema: CreatePlatformTenantResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tạo công ty không đúng định dạng. Công ty có thể đã được tạo — hãy tải lại danh sách để kiểm tra.",
  });
}

/**
 * Both directions carry a reason: the server enforces the same ≥10 rule on
 * suspend AND activate (`_lib/set-status.ts`), because both are entries in the
 * same book.
 */
function requireReason(reason: string, action: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) {
    const userMessage = `Nêu lý do ${action} công ty trước khi tiếp tục.`;
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${action} requires a reason`,
      userMessage,
      issues: [{ path: "reason", message: userMessage }],
    });
  }
  return trimmed;
}

export async function suspendPlatformTenant(
  params: { tenantId: string; reason: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return apiRequest(
    `/api/platform/tenants/${encodeURIComponent(requireTenantId(params.tenantId))}/suspend`,
    {
      method: "POST",
      body: { reason: requireReason(params.reason, "khoá") },
      schema: PlatformTenantMutationResponseSchema,
      signal,
      malformedMessage:
        "Kết quả khoá công ty không đúng định dạng. Hãy tải lại danh sách để xem trạng thái thật.",
    },
  );
}

export async function activatePlatformTenant(
  params: { tenantId: string; reason: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return apiRequest(
    `/api/platform/tenants/${encodeURIComponent(requireTenantId(params.tenantId))}/activate`,
    {
      method: "POST",
      body: { reason: requireReason(params.reason, "mở khoá") },
      schema: PlatformTenantMutationResponseSchema,
      signal,
      malformedMessage:
        "Kết quả mở khoá không đúng định dạng. Hãy tải lại danh sách để xem trạng thái thật.",
    },
  );
}

/**
 * Support mode (M3.3): step INTO a customer's company, read-only and
 * time-boxed. The purpose travels with it because the entry is written into
 * that customer's audit trail — this is the one call whose side effect is a
 * line somebody else reads.
 *
 * Never auto-retried: two calls are two sessions and two lines in their book.
 */
export async function startSupportSession(
  params: { tenantId: string; purpose: string },
  signal?: AbortSignal,
): Promise<StartSupportSessionResponse> {
  const purpose = params.purpose?.trim() ?? "";
  if (purpose.length === 0) {
    const userMessage = "Nêu mục đích vào hỗ trợ trước khi tiếp tục.";
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "startSupportSession requires a purpose",
      userMessage,
      issues: [{ path: "purpose", message: userMessage }],
    });
  }

  return apiRequest("/api/platform/tenant-sessions", {
    method: "POST",
    body: { tenantId: requireTenantId(params.tenantId), purpose },
    schema: StartSupportSessionResponseSchema,
    signal,
    malformedMessage:
      "Kết quả vào hỗ trợ không đúng định dạng. Hãy tải lại trang để xem bạn đang ở công ty nào.",
  });
}

/** Step back out. The cookie is cleared server-side; the UI re-reads /api/me. */
export async function endSupportSession(signal?: AbortSignal): Promise<unknown> {
  return apiRequest("/api/platform/tenant-sessions/current", {
    method: "DELETE",
    schema: EndSupportSessionResponseSchema,
    signal,
    malformedMessage:
      "Kết quả thoát hỗ trợ không đúng định dạng. Hãy tải lại trang để xem bạn đang ở công ty nào.",
  });
}
