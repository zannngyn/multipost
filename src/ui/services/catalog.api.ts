import {
  RunSyncResponseSchema,
  SyncStatusResponseSchema,
  type RunSyncResponse,
  type SyncStatusResponse,
} from "@/ui/schemas/sync.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the catalog sync screen (docs/07 §4.1).
 * Read: GET /api/catalog/sync-status · Write: POST /api/catalog/sync.
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
