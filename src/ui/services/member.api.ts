import {
  MemberListResponseSchema,
  MemberMutationResponseSchema,
  type MemberListResponse,
} from "@/ui/schemas/member.schema";
import type { MembershipRole } from "@/ui/schemas/me.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the "Thành viên" screen (M2.3), docs/07 §4.1.
 *   GET    /api/members             who is in the company of the session
 *   PUT    /api/members/:id {role}  change one member's role
 *   DELETE /api/members/:id         remove one member
 *
 * The company is NOT a parameter (M1.4): it comes from the session. Nothing
 * fails soft here — a role that did not change must never look changed, and a
 * member who is still in must never look removed.
 */

export const memberKeys = {
  list: (tenantKey: string) => ["members", tenantKey] as const,
};

function requireMembershipId(membershipId: string): string {
  const trimmed = typeof membershipId === "string" ? membershipId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "membershipId is required",
      userMessage: "Thiếu mã thành viên.",
    });
  }
  return trimmed;
}

export async function listMembers(signal?: AbortSignal): Promise<MemberListResponse> {
  return apiRequest("/api/members", {
    schema: MemberListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách thành viên không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/** Never auto-retried: a permission change is a write, and it is not idempotent
 *  in its consequences (an operator watching the list must see one outcome). */
export async function updateMemberRole(
  params: { membershipId: string; role: MembershipRole },
  signal?: AbortSignal,
): Promise<unknown> {
  return apiRequest(`/api/members/${encodeURIComponent(requireMembershipId(params.membershipId))}`, {
    method: "PUT",
    body: { role: params.role },
    schema: MemberMutationResponseSchema,
    signal,
    malformedMessage:
      "Kết quả đổi vai trò không đúng định dạng. Hãy tải lại danh sách để xem vai trò thật.",
  });
}

export async function removeMember(
  params: { membershipId: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return apiRequest(`/api/members/${encodeURIComponent(requireMembershipId(params.membershipId))}`, {
    method: "DELETE",
    schema: MemberMutationResponseSchema,
    signal,
    malformedMessage:
      "Kết quả gỡ thành viên không đúng định dạng. Hãy tải lại danh sách để xem ai còn trong công ty.",
  });
}
