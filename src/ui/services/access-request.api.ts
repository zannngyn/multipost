import {
  AccessDecisionResponseSchema,
  AccessRequestListResponseSchema,
  DEFAULT_ACCESS_ROLE,
  type AccessDecision,
  type AccessDecisionResponse,
  type AccessFilterStatus,
  type AccessRequestListResponse,
  type AccessRole,
} from "@/ui/schemas/access-request.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the "Quyền truy cập" screen (E10), docs/07 §4.1.
 *   GET  /api/access-requests?tenantId=&status=   who asked for access
 *   POST /api/access-requests/decide              approve (with a role) / block
 *
 * Nothing fails soft here: a request that was NOT decided must never look
 * decided. Someone reading a stale "Đã duyệt" would stop chasing an account
 * that still cannot sign in — or worse, believe a blocked account is blocked
 * when the write never landed.
 */

export const accessRequestKeys = {
  /** Prefix for every filter of one tenant — one decision invalidates them all. */
  all: (tenantId: string) => ["access-requests", tenantId] as const,
  list: (tenantId: string, status: AccessFilterStatus) =>
    ["access-requests", tenantId, status] as const,
};

function requireTenantId(tenantId: string): string {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant).",
    });
  }
  return trimmed;
}

function requireRequestId(id: string): string {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "access request id is required",
      userMessage: "Thiếu mã yêu cầu truy cập.",
    });
  }
  return trimmed;
}

export async function listAccessRequests(
  tenantId: string,
  status: AccessFilterStatus,
  signal?: AbortSignal,
): Promise<AccessRequestListResponse> {
  // `status` is always sent, including the default: the request then says what
  // it means, and the screen does not depend on a server-side default staying
  // "pending" forever.
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId), status });
  return apiRequest(`/api/access-requests?${query.toString()}`, {
    schema: AccessRequestListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách yêu cầu truy cập không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/**
 * A role only travels with an approval — sending one alongside "block" would
 * describe a permission nobody is being granted.
 */
export async function decideAccessRequest(
  params: { tenantId: string; id: string; decision: AccessDecision; role?: AccessRole },
  signal?: AbortSignal,
): Promise<AccessDecisionResponse> {
  const tenantId = requireTenantId(params.tenantId);
  const id = requireRequestId(params.id);

  const body =
    params.decision === "approve"
      ? { tenantId, id, decision: "approve" as const, role: params.role ?? DEFAULT_ACCESS_ROLE }
      : { tenantId, id, decision: "block" as const };

  return apiRequest("/api/access-requests/decide", {
    method: "POST",
    body,
    schema: AccessDecisionResponseSchema,
    signal,
    malformedMessage:
      "Kết quả duyệt/chặn không đúng định dạng. Hãy tải lại danh sách để xem trạng thái thật.",
  });
}
