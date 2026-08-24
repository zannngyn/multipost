"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

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
 * NOTE for whoever finishes a setup step from another screen.
 *
 * There is deliberately no `useInvalidateSetupProgress` here. One was written
 * and removed before merge: nothing called it, while its own comment claimed
 * other screens "add one line" — a helper that documents a convention nobody
 * follows is worse than no helper, because the next reader believes the wiring
 * exists.
 *
 * Until a screen actually needs it, the 30s `staleTime` is the whole story: a
 * step finished elsewhere shows up on the dock within half a minute, or at once
 * if the operator navigates (which they do — every step lives on another
 * screen). The gap that WOULD matter is a step completed by a pure client-side
 * mutation on a screen the operator then stays on. When you add that, add the
 * invalidation with it:
 *
 *   queryClient.invalidateQueries({ queryKey: setupKeys.progress(tenantKey) })
 */
