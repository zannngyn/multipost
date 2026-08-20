"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { RunSyncResponse, SyncStatusResponse } from "@/ui/schemas/sync.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import { catalogKeys, fetchSyncStatus, runCatalogSync } from "@/ui/services/catalog.api";

/**
 * Logic layer for the sync screen (docs/07 §4.1): owns fetch policy and cache
 * invalidation, never the transport.
 *
 * The company is NOT a parameter any more (M1.4): the server reads it from the
 * session, and the UI reads it from `/api/me` — the hook only needs it to
 * partition the cache and to know when the answer can be asked for at all.
 */
export function useSyncStatus() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<SyncStatusResponse, ApiError>({
    queryKey: catalogKeys.syncStatus(tenantKey),
    queryFn: ({ signal }) => fetchSyncStatus(signal),
    enabled: isResolved,
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}

export function useRunCatalogSync() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<RunSyncResponse, ApiError, void>({
    mutationFn: () => runCatalogSync(),
    // A write is never retried automatically: a sync that half-ran must not be
    // silently started a second time.
    retry: false,
    onSettled: () => {
      // Even a failed run wrote a `failed` sync_run row — the panel must show
      // it, otherwise the screen keeps displaying the previous success.
      void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(tenantKey) });
    },
  });
}
