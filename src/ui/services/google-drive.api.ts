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
  all: (tenantKey: string) => ["google-drive", tenantKey] as const,
  status: (tenantKey: string) => ["google-drive", tenantKey, "status"] as const,
  folders: (tenantKey: string, parentId: string, q: string) =>
    ["google-drive", tenantKey, "folders", parentId, q] as const,
  spreadsheets: (tenantKey: string, q: string) =>
    ["google-drive", tenantKey, "spreadsheets", q] as const,
  tabs: (tenantKey: string, spreadsheetId: string) =>
    ["google-drive", tenantKey, "tabs", spreadsheetId] as const,
};


/**
 * Full-page navigation target for the OAuth round trip — NOT something to
 * fetch. `/api/catalog/google/connect` answers 302 to Google, and following
 * that with `fetch` would either be blocked by CORS or land Google's consent
 * page in a JSON parser (web-auth-methods §1: redirect, not popup, not XHR).
 */
export function googleConnectHref(): string {
  return "/api/catalog/google/connect";
}

export async function fetchGoogleConnection(signal?: AbortSignal): Promise<GoogleConnection> {
  return apiRequest("/api/catalog/google/status", {
    schema: GoogleConnectionSchema,
    signal,
    malformedMessage:
      "Trạng thái kết nối Google không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface ListDriveFoldersParams {
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
  const query = new URLSearchParams();
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
  /** Omitted = search the whole Drive, most recently edited first. */
  parentId?: string | null;
  pageToken?: string | null;
  q?: string | null;
}

export async function listDriveSpreadsheets(
  params: ListDriveSpreadsheetsParams,
  signal?: AbortSignal,
): Promise<DriveSpreadsheetPage> {
  const query = new URLSearchParams();
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
  params: { spreadsheetId: string },
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

  const query = new URLSearchParams({ spreadsheetId });

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
export async function disconnectGoogle(signal?: AbortSignal): Promise<GoogleConnection> {
  return apiRequest("/api/catalog/google/connection", {
    method: "DELETE",
    schema: GoogleConnectionSchema,
    signal,
    malformedMessage:
      "Kết quả ngắt kết nối không đúng định dạng. Hãy tải lại trang để xem trạng thái thật.",
  });
}
