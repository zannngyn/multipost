import {
  ChannelImportResponseSchema,
  ChannelListResponseSchema,
  RemoveChannelResponseSchema,
  SetChannelStatusResponseSchema,
  type ChannelImportResponse,
  type ChannelListResponse,
  type ChannelStatus,
  type RemoveChannelResponse,
  type SetChannelStatusResponse,
} from "@/ui/schemas/channel.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the "Kênh" screen (E5.1), docs/07 §4.1.
 *   GET    /api/channels            list the tenant's Pages
 *   PUT    /api/channels/:id        enable / disable one
 *   DELETE /api/channels/:id        remove one
 *   POST   /api/channels/import     exchange a pasted User Access Token
 *   POST   /api/channels/refresh    re-read the Pages with the stored token
 *
 * Nothing fails soft here: a Page that is not really connected must never look
 * connected — the wizard picks channels from this list, and a wrong list means
 * a post going to the wrong Page (or nowhere at all).
 *
 * SECURITY — the User Access Token:
 *   - travels ONLY inside the POST body of `importChannels`;
 *   - never enters a URL, a query string, a query key, storage or a log line;
 *   - is not part of any response shape (see `channel.schema.ts`).
 * Anything that would put it in `channelKeys` is a bug, not a shortcut.
 */

export const channelKeys = {
  list: (tenantId: string) => ["channels", tenantId] as const,
};

/** Reading Pages from Graph is slower than our own DB — give it real room. */
const GRAPH_ROUNDTRIP_TIMEOUT_MS = 30_000;

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

function requireChannelId(channelId: string): string {
  const trimmed = typeof channelId === "string" ? channelId.trim() : "";
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "channelId is required",
      userMessage: "Thiếu mã kênh.",
    });
  }
  return trimmed;
}

/**
 * Full-page navigation target for the OAuth round trip — NOT something to
 * fetch. `/api/channels/connect` answers 302 to Facebook, and following that
 * with `fetch` would either be blocked by CORS or land the login page in a
 * JSON parser (web-auth-methods §1: redirect, not popup, not XHR).
 */
export function channelConnectHref(tenantId: string): string {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });
  return `/api/channels/connect?${query.toString()}`;
}

export async function listChannels(
  tenantId: string,
  signal?: AbortSignal,
): Promise<ChannelListResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });
  return apiRequest(`/api/channels?${query.toString()}`, {
    schema: ChannelListResponseSchema,
    signal,
    malformedMessage:
      "Danh sách kênh không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function setChannelStatus(
  params: { tenantId: string; channelId: string; status: ChannelStatus },
  signal?: AbortSignal,
): Promise<SetChannelStatusResponse> {
  return apiRequest(`/api/channels/${encodeURIComponent(requireChannelId(params.channelId))}`, {
    method: "PUT",
    body: { tenantId: requireTenantId(params.tenantId), status: params.status },
    schema: SetChannelStatusResponseSchema,
    signal,
    malformedMessage:
      "Kết quả bật/tắt kênh không đúng định dạng. Hãy tải lại danh sách để kiểm tra.",
  });
}

export async function removeChannel(
  params: { tenantId: string; channelId: string },
  signal?: AbortSignal,
): Promise<RemoveChannelResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });
  return apiRequest(
    `/api/channels/${encodeURIComponent(requireChannelId(params.channelId))}?${query.toString()}`,
    {
      method: "DELETE",
      schema: RemoveChannelResponseSchema,
      signal,
      malformedMessage: "Kết quả gỡ kênh không đúng định dạng. Hãy tải lại danh sách để kiểm tra.",
    },
  );
}

export async function importChannels(
  params: { tenantId: string; userAccessToken: string },
  signal?: AbortSignal,
): Promise<ChannelImportResponse> {
  const token = typeof params.userAccessToken === "string" ? params.userAccessToken.trim() : "";
  if (token.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      // The value itself is never echoed back — not even its length.
      message: "userAccessToken is required",
      userMessage: "Dán User Access Token trước khi lấy danh sách Page.",
    });
  }

  return apiRequest("/api/channels/import", {
    method: "POST",
    body: { tenantId: requireTenantId(params.tenantId), userAccessToken: token },
    schema: ChannelImportResponseSchema,
    signal,
    timeoutMs: GRAPH_ROUNDTRIP_TIMEOUT_MS,
    malformedMessage:
      "Kết quả lấy danh sách Page không đúng định dạng. Hãy tải lại trang để kiểm tra.",
  });
}

export async function refreshChannels(
  params: { tenantId: string },
  signal?: AbortSignal,
): Promise<ChannelImportResponse> {
  return apiRequest("/api/channels/refresh", {
    method: "POST",
    body: { tenantId: requireTenantId(params.tenantId) },
    schema: ChannelImportResponseSchema,
    signal,
    timeoutMs: GRAPH_ROUNDTRIP_TIMEOUT_MS,
    malformedMessage:
      "Kết quả làm mới danh sách Page không đúng định dạng. Hãy tải lại trang để kiểm tra.",
  });
}
