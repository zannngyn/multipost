import {
  DriveFolderPageSchema,
  DriveSpreadsheetPageSchema,
  GoogleConnectionSchema,
  SpreadsheetTabsSchema,
  type DriveFolderPage,
  type DriveSpreadsheetPage,
  type GoogleConnection,
  type SpreadsheetTabs,
} from "@/ui/schemas/google-drive.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the Google Drive connection block (docs/07 §4.1).
 *
 * Read: GET /api/catalog/google/status · /folders · /spreadsheets ·
 * /spreadsheets/tabs — Write: DELETE /api/catalog/google/connection.
 *
 * The browser NEVER talks to Drive itself: every call here goes to an internal
 * route that holds the tenant's token server-side (business rule: UI reads the
 * database through internal APIs only).
 */

export const googleDriveKeys = {
  all: (tenantId: string) => ["google-drive", tenantId] as const,
  status: (tenantId: string) => ["google-drive", tenantId, "status"] as const,
  folders: (tenantId: string, parentId: string, q: string) =>
    ["google-drive", tenantId, "folders", parentId, q] as const,
  spreadsheets: (tenantId: string, q: string) =>
    ["google-drive", tenantId, "spreadsheets", q] as const,
  tabs: (tenantId: string, spreadsheetId: string) =>
    ["google-drive", tenantId, "tabs", spreadsheetId] as const,
};

function requireTenantId(tenantId: string): string {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  // Guard: never spend a round-trip on a request we already know is invalid.
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant) để đọc Google Drive.",
    });
  }
  return trimmed;
}

/**
 * Full-page navigation target for the OAuth round trip — NOT something to
 * fetch. `/api/catalog/google/connect` answers 302 to Google, and following
 * that with `fetch` would either be blocked by CORS or land Google's consent
 * page in a JSON parser (web-auth-methods §1: redirect, not popup, not XHR).
 */
export function googleConnectHref(tenantId: string): string {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });
  return `/api/catalog/google/connect?${query.toString()}`;
}

export async function fetchGoogleConnection(
  tenantId: string,
  signal?: AbortSignal,
): Promise<GoogleConnection> {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });

  return apiRequest(`/api/catalog/google/status?${query.toString()}`, {
    schema: GoogleConnectionSchema,
    signal,
    malformedMessage:
      "Trạng thái kết nối Google không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ListDriveFoldersParams {
  tenantId: string;
  /** `root` (the default) lists the top of My Drive. */
  parentId?: string;
  pageToken?: string | null;
  /** Search by name; the server decides the scope. */
  q?: string | null;
}

export async function listDriveFolders(
  params: ListDriveFoldersParams,
  signal?: AbortSignal,
): Promise<DriveFolderPage> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });
  query.set("parentId", params.parentId?.trim() || "root");
  if (params.pageToken) query.set("pageToken", params.pageToken);
  const q = params.q?.trim() ?? "";
  if (q.length > 0) query.set("q", q);

  return apiRequest(`/api/catalog/google/folders?${query.toString()}`, {
    schema: DriveFolderPageSchema,
    signal,
    malformedMessage:
      "Danh sách thư mục Drive không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ListDriveSpreadsheetsParams {
  tenantId: string;
  /** Omitted = search the whole Drive, most recently edited first. */
  parentId?: string | null;
  pageToken?: string | null;
  q?: string | null;
}

export async function listDriveSpreadsheets(
  params: ListDriveSpreadsheetsParams,
  signal?: AbortSignal,
): Promise<DriveSpreadsheetPage> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });
  const parentId = params.parentId?.trim() ?? "";
  if (parentId.length > 0) query.set("parentId", parentId);
  if (params.pageToken) query.set("pageToken", params.pageToken);
  const q = params.q?.trim() ?? "";
  if (q.length > 0) query.set("q", q);

  return apiRequest(`/api/catalog/google/spreadsheets?${query.toString()}`, {
    schema: DriveSpreadsheetPageSchema,
    signal,
    malformedMessage:
      "Danh sách bảng Google Sheet không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function fetchSpreadsheetTabs(
  params: { tenantId: string; spreadsheetId: string },
  signal?: AbortSignal,
): Promise<SpreadsheetTabs> {
  const spreadsheetId = params.spreadsheetId?.trim() ?? "";
  if (spreadsheetId.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "spreadsheetId is required",
      userMessage: "Chọn bảng Google Sheet trước khi chọn tab.",
    });
  }

  const query = new URLSearchParams({
    tenantId: requireTenantId(params.tenantId),
    spreadsheetId,
  });

  return apiRequest(`/api/catalog/google/spreadsheets/tabs?${query.toString()}`, {
    schema: SpreadsheetTabsSchema,
    signal,
    malformedMessage:
      "Danh sách tab của bảng không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/**
 * Drops the stored Google token. Never retried automatically: a write that
 * half-applied must not be repeated behind the operator's back.
 */
export async function disconnectGoogle(
  tenantId: string,
  signal?: AbortSignal,
): Promise<GoogleConnection> {
  return apiRequest("/api/catalog/google/connection", {
    method: "DELETE",
    body: { tenantId: requireTenantId(tenantId) },
    schema: GoogleConnectionSchema,
    signal,
    malformedMessage:
      "Kết quả ngắt kết nối không đúng định dạng. Hãy tải lại trang để xem trạng thái thật.",
  });
}
