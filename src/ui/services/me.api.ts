import {
  MeResponseSchema,
  SetActiveTenantResponseSchema,
  type MeResponse,
  type SetActiveTenantResponse,
} from "@/ui/schemas/me.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Session context (M1.4, docs/07 §4.1).
 *   GET  /api/me                 account + companies + active company
 *   POST /api/me/active-tenant   switch the working company (sets the cookie)
 *
 * `tenantId` in the switch body is the ONE tenant id the client still sends,
 * and it is not a claim of authority: it is the OBJECT of the request. The
 * server re-checks the membership (tier S) and answers 404 TENANT_NOT_FOUND if
 * the account is not a member — the browser cannot select its way into a
 * company it does not belong to.
 */

export const meKeys = {
  me: () => ["me"] as const,
};

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest("/api/me", {
    schema: MeResponseSchema,
    signal,
    malformedMessage:
      "Thông tin tài khoản trả về không đúng định dạng. Hãy tải lại trang; nếu vẫn lỗi, báo quản trị viên.",
  });
}

export async function setActiveTenant(
  tenantId: string,
  signal?: AbortSignal,
): Promise<SetActiveTenantResponse> {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  // Guard: never spend a round trip on a request we already know is invalid.
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required to switch company",
      userMessage: "Chưa chọn công ty nào.",
    });
  }

  return apiRequest("/api/me/active-tenant", {
    method: "POST",
    body: { tenantId: trimmed },
    schema: SetActiveTenantResponseSchema,
    signal,
    malformedMessage:
      "Kết quả đổi công ty không đúng định dạng. Hãy tải lại trang để xem bạn đang ở công ty nào.",
  });
}
