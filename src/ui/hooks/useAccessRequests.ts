"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type {
  AccessFilterStatus,
  AccessRequestListResponse,
} from "@/ui/schemas/access-request.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import { accessRequestKeys, listAccessRequests } from "@/ui/services/access-request.api";

/**
 * Logic layer of the "Quyền truy cập" screen (E10), docs/07 §4.1.
 *
 * The filter is part of the query key, so switching tabs is a different query —
 * and `keepPreviousData` keeps the rows of the previous filter on screen while
 * the new answer arrives, instead of flashing back to a skeleton
 * (core-data-list-query §Hiệu năng).
 *
 * READ-ONLY since M2.4: the approval queue is retired (people join with an
 * invite link), and this list is kept as history. The decide mutation went with
 * the flow it belonged to — leaving it here would be a loaded gun for the next
 * screen that imports it.
 */

export function useAccessRequests(status: AccessFilterStatus) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<AccessRequestListResponse, ApiError>({
    queryKey: accessRequestKeys.list(tenantKey, status),
    queryFn: ({ signal }) => listAccessRequests(status, signal),
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    placeholderData: keepPreviousData,
    // Short: someone else may be approving from another browser, and an admin
    // acting on a stale row is exactly what this screen exists to prevent.
    staleTime: 15_000,
  });
}
