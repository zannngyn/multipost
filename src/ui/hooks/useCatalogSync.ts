"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { RunSyncResponse, SyncStatusResponse } from "@/ui/schemas/sync.schema";
import { ApiError } from "@/ui/services/api-error";
import { catalogKeys, fetchSyncStatus, runCatalogSync } from "@/ui/services/catalog.api";

/**
 * Logic layer for the sync screen (docs/07 §4.1): owns fetch policy and cache
 * invalidation, never the transport.
 */

/** `tenantId === null` = the operator has not picked a tenant yet (idle). */
export function useSyncStatus(tenantId: string | null) {
  return useQuery<SyncStatusResponse, ApiError>({
    queryKey: catalogKeys.syncStatus(tenantId ?? "none"),
    queryFn: ({ signal }) => fetchSyncStatus(tenantId ?? "", signal),
    enabled: tenantId !== null,
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}

export function useRunCatalogSync(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation<RunSyncResponse, ApiError, void>({
    mutationFn: () => runCatalogSync(tenantId ?? ""),
    // A write is never retried automatically: a sync that half-ran must not be
    // silently started a second time.
    retry: false,
    onSettled: () => {
      // Even a failed run wrote a `failed` sync_run row — the panel must show
      // it, otherwise the screen keeps displaying the previous success.
      void queryClient.invalidateQueries({
        queryKey: catalogKeys.syncStatus(tenantId ?? "none"),
      });
    },
  });
}
