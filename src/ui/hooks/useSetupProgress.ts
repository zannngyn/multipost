"use client";

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type { SetupProgress } from "@/ui/schemas/setup-progress.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchSetupProgress, setupKeys } from "@/ui/services/setup-progress.api";

/**
 * Logic layer of the setup dock and the first-run checklist (docs/07 §4.1):
 * fetch policy and cache keys live here, transport does not.
 *
 * The dock rides in the app shell, so this query would otherwise fire on EVERY
 * screen for EVERY operator. Two gates keep that honest:
 *   - only owner/admin ask at all — the endpoint answers 403 to anyone else,
 *     and an editor has no button for a single one of these steps;
 *   - `staleTime` 30s, so moving between screens re-reads the cache, not the
 *     API. Setup state changes when somebody presses a button on another
 *     screen, not on a timer, which is why this does not poll.
 */
export function useSetupProgress(): UseQueryResult<SetupProgress, ApiError> {
  const { tenantKey, isResolved, role } = useActiveTenant();
  const canSee = role === "owner" || role === "admin";

  return useQuery<SetupProgress, ApiError>({
    queryKey: setupKeys.progress(tenantKey),
    queryFn: ({ signal }) => fetchSetupProgress(signal),
    enabled: isResolved && canSee,
    // A 4xx repeats the same bad request — retrying only hides it.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}

/**
 * Re-read the six flags after an action that could have finished a step.
 *
 * Setup state is changed from screens that know nothing about the dock (the
 * sync screen connects Google, the channels screen adds a Fanpage). Those
 * screens invalidate their OWN keys; this is the one line they add so the dock
 * does not keep pointing at a step the operator just completed.
 */
export function useInvalidateSetupProgress(): () => void {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: setupKeys.progress(tenantKey) });
  }, [queryClient, tenantKey]);
}
