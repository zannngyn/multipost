import {
  CatalogProductsResponseSchema,
  CatalogSourceResponseSchema,
  PRODUCTS_DEFAULT_LIMIT,
  type CatalogProductsResponse,
  type CatalogSourceResponse,
  type ProductFilter,
} from "@/ui/schemas/catalog.schema";
import {
  RunSyncResponseSchema,
  SyncStatusResponseSchema,
  type RunSyncResponse,
  type SyncStatusResponse,
} from "@/ui/schemas/sync.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the catalog screens (docs/07 §4.1).
 * Read: GET /api/catalog/sync-status · /api/catalog/source ·
 * /api/catalog/products · Write: POST /api/catalog/sync.
 *
 * Nothing fails soft here: a sync that did not run must never look like a sync
 * that ran and found nothing (core-data-fetching: fail-soft is forbidden for
 * writes, and this screen IS the audit trail).
 */

/**
 * A full Drive+Sheet sync is inline in Phase 1 and walks thousands of files.
 * The client waits longer than the 15s default — but still bounded, so a dead
 * request becomes a visible error instead of a spinner that never ends.
 */
const SYNC_RUN_TIMEOUT_MS = 120_000;

export const catalogKeys = {
  syncStatus: (tenantId: string) => ["catalog", tenantId, "sync-status"] as const,
  source: (tenantId: string) => ["catalog", tenantId, "source"] as const,
  /** Derived from the SAME filter object the URL produced — no second source. */
  products: (tenantId: string, filter: ProductFilter) =>
    ["catalog", tenantId, "products", filter.status ?? "all", filter.q ?? ""] as const,
};

function requireTenantId(tenantId: string): string {
  const trimmed = typeof tenantId === "string" ? tenantId.trim() : "";
  // Guard: never spend a round-trip on a request we already know is invalid.
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant) để đồng bộ.",
    });
  }
  return trimmed;
}

export async function fetchSyncStatus(
  tenantId: string,
  signal?: AbortSignal,
): Promise<SyncStatusResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });

  return apiRequest(`/api/catalog/sync-status?${query.toString()}`, {
    schema: SyncStatusResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu trạng thái đồng bộ không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function fetchCatalogSource(
  tenantId: string,
  signal?: AbortSignal,
): Promise<CatalogSourceResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(tenantId) });

  return apiRequest(`/api/catalog/source?${query.toString()}`, {
    schema: CatalogSourceResponseSchema,
    signal,
    malformedMessage:
      "Thông tin nguồn dữ liệu không đúng định dạng. Hãy báo quản trị viên kiểm tra cấu hình đơn vị.",
  });
}

export interface UpdateCatalogSourceParams {
  tenantId: string;
  /** A pasted browser link or a bare id — the server parses both. */
  driveFolder: string;
  spreadsheet: string;
  sheetName: string;
}

/**
 * Replaces the tenant's Drive/Sheet source. Never retried automatically: a
 * write that half-applied must not be repeated behind the operator's back.
 */
export async function updateCatalogSource(
  params: UpdateCatalogSourceParams,
  signal?: AbortSignal,
): Promise<CatalogSourceResponse> {
  const driveFolder = params.driveFolder?.trim() ?? "";
  const spreadsheet = params.spreadsheet?.trim() ?? "";
  const sheetName = params.sheetName?.trim() ?? "";

  // Guards: a round trip would only return the same 400 we can raise here.
  if (driveFolder.length === 0 || spreadsheet.length === 0 || sheetName.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "updateCatalogSource requires driveFolder, spreadsheet and sheetName",
      userMessage: "Điền đủ thư mục Drive, bảng Sheet và tên tab trước khi lưu.",
    });
  }

  return apiRequest("/api/catalog/source", {
    method: "PUT",
    body: { tenantId: requireTenantId(params.tenantId), driveFolder, spreadsheet, sheetName },
    schema: CatalogSourceResponseSchema,
    signal,
    malformedMessage:
      "Kết quả lưu nguồn dữ liệu không đúng định dạng. Hãy tải lại trang để xem nguồn đang được dùng.",
  });
}

export interface ListCatalogProductsParams {
  tenantId: string;
  filter: ProductFilter;
  cursor?: string | null;
  limit?: number;
}

export async function listCatalogProducts(
  params: ListCatalogProductsParams,
  signal?: AbortSignal,
): Promise<CatalogProductsResponse> {
  const query = new URLSearchParams({ tenantId: requireTenantId(params.tenantId) });
  if (params.filter.status) query.set("status", params.filter.status);
  if (params.filter.q) query.set("q", params.filter.q);
  if (params.cursor) query.set("cursor", params.cursor);
  query.set("limit", String(params.limit ?? PRODUCTS_DEFAULT_LIMIT));

  return apiRequest(`/api/catalog/products?${query.toString()}`, {
    schema: CatalogProductsResponseSchema,
    signal,
    malformedMessage:
      "Danh sách sản phẩm trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function runCatalogSync(
  tenantId: string,
  signal?: AbortSignal,
): Promise<RunSyncResponse> {
  return apiRequest("/api/catalog/sync", {
    method: "POST",
    body: { tenantId: requireTenantId(tenantId) },
    schema: RunSyncResponseSchema,
    signal,
    timeoutMs: SYNC_RUN_TIMEOUT_MS,
    malformedMessage:
      "Kết quả đồng bộ không đúng định dạng. Đồng bộ có thể đã chạy — hãy tải lại trạng thái để kiểm tra.",
  });
}
