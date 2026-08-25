"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useMe } from "@/ui/hooks/useMe";
import type {
  AppearancePresetId,
  AppearanceSettings,
  UpdateAppearanceResponse,
} from "@/ui/schemas/appearance.schema";
import { ApiError } from "@/ui/services/api-error";
import { appearanceKeys, readAppearance, updateAppearance } from "@/ui/services/appearance.api";

/**
 * Logic layer of the appearance screen (M3.4), docs/07 §4.1.
 *
 * The query key carries no tenant segment: the value belongs to the platform,
 * and it must survive a company switch untouched — like the tenant list, this
 * is a screen used from outside every company.
 */

export function useAppearance() {
  const me = useMe();
  const platformRole = me.data?.account?.platformRole ?? null;

  return useQuery<AppearanceSettings, ApiError>({
    queryKey: appearanceKeys.settings(),
    queryFn: ({ signal }) => readAppearance(signal),
    // Nothing is asked until `/api/me` says this account may ask: a 403 the UI
    // could have predicted is a 403 nobody needs to see.
    enabled: me.data !== undefined && platformRole !== null,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}

export function useUpdateAppearance() {
  const queryClient = useQueryClient();

  return useMutation<UpdateAppearanceResponse, ApiError, AppearancePresetId>({
    mutationFn: (presetId) => updateAppearance(presetId),
    retry: false,
    onSuccess: (result) => {
      // Write the answer we were given rather than refetching: the server just
      // told us what it stored, and a refetch could race the read cache in the
      // process that served it.
      queryClient.setQueryData<AppearanceSettings>(appearanceKeys.settings(), {
        presetId: result.presetId,
        isDefault: false,
      });
    },
  });
}
