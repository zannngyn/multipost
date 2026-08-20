import {
  AccessRequestListResponseSchema,
  type AccessFilterStatus,
  type AccessRequestListResponse,
} from "@/ui/schemas/access-request.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer of the "Quyền truy cập" screen (E10), docs/07 §4.1.
 *   GET  /api/access-requests?status=            who asked for access
 *   POST /api/access-requests/decide              approve (with a role) / block
 *
 * Nothing fails soft here: a request that was NOT decided must never look
 * decided. Someone reading a stale "Đã duyệt" would stop chasing an account
 * that still cannot sign in — or worse, believe a blocked account is blocked
 * when the write never landed.
 */

export const accessRequestKeys = {
  /** Prefix for every filter of one company — one decision invalidates them all. */
  all: (tenantKey: string) => ["access-requests", tenantKey] as const,
  list: (tenantKey: string, status: AccessFilterStatus) =>
    ["access-requests", tenantKey, status] as const,
};



export async function listAccessRequests(
  status: AccessFilterStatus,
  signal?: AbortSignal,
): Promise<AccessRequestListResponse> {
  // `status` is always sent, including the default: the request then says what
  // it means, and the screen does not depend on a server-side default staying
  // "pending" forever.
  const query = new URLSearchParams({ status });
  return apiRequest(`/api/access-requests?${query.toString()}`, {
    schema: AccessRequestListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách yêu cầu truy cập không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
