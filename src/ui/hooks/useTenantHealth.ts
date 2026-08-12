"use client";

import { useQuery } from "@tanstack/react-query";

import type { TenantHealth } from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchTenantHealth, tenantKeys } from "@/ui/services/tenant.api";

/**
 * Logic layer: owns fetch policy, never the transport (docs/07 §4.1).
 * `tenantId === null` means "operator has not asked yet" -> idle/empty state.
 */
export function useTenantHealth(tenantId: string | null) {
  return useQuery<TenantHealth, ApiError>({
    queryKey: tenantKeys.health(tenantId ?? "none"),
    queryFn: ({ signal }) => fetchTenantHealth(tenantId ?? "", signal),
    enabled: tenantId !== null,
    // 4xx means the request itself is wrong — retrying repeats the same mistake.
    retry: (failureCount, error) => (ApiError.is(error) && error.isRetryable ? failureCount < 2 : false),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}
