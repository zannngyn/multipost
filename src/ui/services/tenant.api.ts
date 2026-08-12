import { TenantHealthSchema, type TenantHealth } from "@/ui/schemas/tenant-health.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for tenant screens: talks to the internal HTTP API and nothing
 * else (docs/07 §4.1). No React, no business branching — components and hooks
 * never call `fetch` themselves.
 *
 * Transport, timeout and error normalisation live in `http-client.ts`; this
 * file only owns the endpoint, its contract and its guard clauses.
 */

/** Query keys carry the tenant id so cached data can never leak across tenants. */
export const tenantKeys = {
  health: (tenantId: string) => ["tenant", tenantId, "health"] as const,
};

export async function fetchTenantHealth(
  tenantId: string,
  signal?: AbortSignal,
): Promise<TenantHealth> {
  // Guard: never send an empty query — that would be a 400 round-trip for free.
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "tenantId is required",
      userMessage: "Chưa có mã đơn vị (tenant) để kiểm tra.",
    });
  }

  const query = new URLSearchParams({ tenantId: tenantId.trim() });

  return apiRequest(`/api/tenants/health?${query.toString()}`, {
    schema: TenantHealthSchema,
    signal,
    malformedMessage:
      "Dữ liệu tình trạng đơn vị không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
