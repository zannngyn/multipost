import {
  CreateInviteResponseSchema,
  InviteListResponseSchema,
  RevokeInviteResponseSchema,
  type CreateInviteResponse,
  type InviteListResponse,
  type RevokeInviteResponse,
} from "@/ui/schemas/invite.schema";
import type { MembershipRole } from "@/ui/schemas/me.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the invite links (M2.3 screen over the M2.2 API), docs/07 §4.1.
 *
 * SECURITY: the url comes back from `createInvite` and NOWHERE else. It is
 * returned to the caller and held in the mutation's answer (memory only) — it
 * is never put in a query key, so it cannot end up in a cache dump or a
 * devtools key list, and it is never logged.
 */

export const inviteKeys = {
  list: (tenantKey: string) => ["invites", tenantKey] as const,
};

function requireInviteId(inviteId: string): string {
  const trimmed = typeof inviteId === "string" ? inviteId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "inviteId is required",
      userMessage: "Thiếu mã link mời.",
    });
  }
  return trimmed;
}

export async function listInvites(signal?: AbortSignal): Promise<InviteListResponse> {
  return apiRequest("/api/invites", {
    schema: InviteListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách link mời không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/** Never auto-retried: a second call mints a SECOND live invite link. */
export async function createInvite(
  params: { role: MembershipRole },
  signal?: AbortSignal,
): Promise<CreateInviteResponse> {
  return apiRequest("/api/invites", {
    method: "POST",
    body: { role: params.role },
    schema: CreateInviteResponseSchema,
    signal,
    malformedMessage:
      "Kết quả tạo link mời không đúng định dạng. Hãy tải lại danh sách — link có thể đã được tạo.",
  });
}

export async function revokeInvite(
  params: { inviteId: string },
  signal?: AbortSignal,
): Promise<RevokeInviteResponse> {
  return apiRequest(`/api/invites/${encodeURIComponent(requireInviteId(params.inviteId))}`, {
    method: "DELETE",
    schema: RevokeInviteResponseSchema,
    signal,
    malformedMessage:
      "Kết quả thu hồi không đúng định dạng. Hãy tải lại danh sách để xem link còn dùng được không.",
  });
}
