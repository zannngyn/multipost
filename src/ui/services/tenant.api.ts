import { TenantHealthSchema, type TenantHealth } from "@/ui/schemas/tenant-health.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer for tenant screens: talks to the internal HTTP API and nothing
 * else (docs/07 §4.1). No React, no business branching — components and hooks
 * never call `fetch` themselves.
 *
 * Transport, timeout and error normalisation live in `http-client.ts`; this
 * file only owns the endpoint, its contract and its guard clauses.
 */

/** Query keys carry the tenant key so cached data can never leak across tenants. */
export const tenantKeys = {
  health: (tenantKey: string) => ["tenant", tenantKey, "health"] as const,
};

export async function fetchTenantHealth(signal?: AbortSignal): Promise<TenantHealth> {
  return apiRequest("/api/tenants/health", {
    schema: TenantHealthSchema,
    signal,
    malformedMessage:
      "Dữ liệu tình trạng đơn vị không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
