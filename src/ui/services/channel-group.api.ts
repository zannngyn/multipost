import {
  ChannelGroupListResponseSchema,
  ChannelGroupSchema,
  DeleteChannelGroupResponseSchema,
  type ChannelGroup,
  type ChannelGroupListResponse,
  type DeleteChannelGroupResponse,
} from "@/ui/schemas/channel-group.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the preset channel groups (E7.6 / E10.3), docs/07 §4.1.
 * GET/POST /api/channel-groups · PUT/DELETE /api/channel-groups/:id.
 *
 * Nothing fails soft: a group that was not created must never look like one
 * that was — the wizard picks channels from this list, so a wrong list means a
 * post going to the wrong Page.
 */

export const channelGroupKeys = {
  list: (tenantId: string) => ["channel-groups", tenantId] as const,
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

function requireGroupId(groupId: string): string {
  const trimmed = typeof groupId === "string" ? groupId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "groupId is required",
      userMessage: "Thiếu mã nhóm kênh.",
    });
  }
  return trimmed;
}

export async function listChannelGroups(
  tenantId: string,
  signal?: AbortSignal,
): Promise<ChannelGroupListResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });
  return apiRequest(`/api/channel-groups?${query.toString()}`, {
    schema: ChannelGroupListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách nhóm kênh không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ChannelGroupPayload {
  tenantId: string;
  name: string;
  channelIds: readonly string[];
}

export async function createChannelGroup(
  payload: ChannelGroupPayload,
  signal?: AbortSignal,
): Promise<ChannelGroup> {
  return apiRequest("/api/channel-groups", {
    method: "POST",
    body: {
      tenantId: requireTenantId(payload.tenantId),
      name: payload.name,
      channelIds: [...payload.channelIds],
    },
    schema: ChannelGroupSchema,
    signal,
    malformedMessage:
      "Kết quả tạo nhóm kênh không đúng định dạng. Hãy tải lại danh sách để kiểm tra.",
  });
}

export async function updateChannelGroup(
  payload: ChannelGroupPayload & { groupId: string },
  signal?: AbortSignal,
): Promise<ChannelGroup> {
  return apiRequest(`/api/channel-groups/${encodeURIComponent(requireGroupId(payload.groupId))}`, {
    method: "PUT",
    body: {
      tenantId: requireTenantId(payload.tenantId),
      name: payload.name,
      channelIds: [...payload.channelIds],
    },
    schema: ChannelGroupSchema,
    signal,
    malformedMessage:
      "Kết quả sửa nhóm kênh không đúng định dạng. Hãy tải lại danh sách để kiểm tra.",
  });
}

export async function deleteChannelGroup(
  params: { tenantId: string; groupId: string },
  signal?: AbortSignal,
): Promise<DeleteChannelGroupResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });
  return apiRequest(
    `/api/channel-groups/${encodeURIComponent(requireGroupId(params.groupId))}?${query.toString()}`,
    {
      method: "DELETE",
      schema: DeleteChannelGroupResponseSchema,
      signal,
      malformedMessage:
        "Kết quả xoá nhóm kênh không đúng định dạng. Hãy tải lại danh sách để kiểm tra.",
    },
  );
}
