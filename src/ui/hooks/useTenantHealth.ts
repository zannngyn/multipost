"use client";

import { useQuery } from "@tanstack/react-query";

import type { TenantHealth } from "@/ui/schemas/tenant-health.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import { fetchTenantHealth, tenantKeys } from "@/ui/services/tenant.api";

/**
 * Logic layer: owns fetch policy, never the transport (docs/07 §4.1).
 * The company comes from the session (M1.4); until `/api/me` has answered there
 * is nothing to ask about, which is the idle state.
 */
export function useTenantHealth() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<TenantHealth, ApiError>({
    queryKey: tenantKeys.health(tenantKey),
    queryFn: ({ signal }) => fetchTenantHealth(signal),
    enabled: isResolved,
    // 4xx means the request itself is wrong — retrying repeats the same mistake.
    retry: (failureCount, error) => (ApiError.is(error) && error.isRetryable ? failureCount < 2 : false),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}
