"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type { CatalogProfileResponse } from "@/ui/schemas/catalog-mapping.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  catalogMappingKeys,
  profileCatalogSource,
  type ProfileCatalogSourceParams,
} from "@/ui/services/catalog-mapping.api";
import { catalogKeys } from "@/ui/services/catalog.api";

/**
 * Logic layer of the "Kết nối dữ liệu" screen (docs/07 §4.1): fetch policy and
 * cache keys live here, transport does not.
 *
 * TWO entry points on purpose, because they answer two different questions:
 *
 *  - `useCatalogProfile()` — the BASELINE report, run against the map the server
 *    infers from the header row. It is what step 2 shows and what step 3 fills
 *    its dropdowns from, and it is a query so a reload does not lose it.
 *  - `useProfilePreview()` — "chạy lại với ánh xạ tôi đang sửa". A mutation,
 *    because it is fired by a button and its result belongs to that press: a
 *    query keyed by the whole draft map would re-run on every dropdown change
 *    and hammer the Sheet API while somebody is still choosing.
 */

/** Nothing is fetched until `/api/me` says which company we are in (M1.4). */
export function useCatalogProfile(options: { enabled?: boolean } = {}) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<CatalogProfileResponse, ApiError>({
    queryKey: catalogMappingKeys.profile(tenantKey),
    queryFn: ({ signal }) => profileCatalogSource({}, signal),
    enabled: isResolved && (options.enabled ?? true),
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 1 : false,
    retryDelay: (attempt) => Math.min(2_000 * 2 ** attempt, 8_000),
    /**
     * The report walks the whole spreadsheet and samples Drive, so it is
     * expensive on someone else's API quota. It is NOT refetched on focus or
     * remount inside a session: an operator switching tabs must not fire a new
     * pass. "Chạy lại báo cáo" is a button, and the numbers carry the time they
     * were measured.
     */
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}

/**
 * Preview run for the map being edited. Nothing is written, so re-firing it is
 * safe — but it is still not retried automatically: the operator pressed a
 * button and must see what that press produced, including a failure.
 */
export function useProfilePreview() {
  return useMutation<CatalogProfileResponse, ApiError, ProfileCatalogSourceParams>({
    mutationFn: (params) => profileCatalogSource(params),
    retry: false,
  });
}

/**
 * Everything derived from the OLD mapping, dropped after a save.
 *
 * The catalog itself is NOT rewritten by saving a map — that happens at the next
 * sync — but the baseline report, the source card and the product list were all
 * produced under the previous configuration, and leaving them on screen would
 * show numbers that describe a setup nobody uses any more.
 */
export function useInvalidateMapping() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return () => {
    void queryClient.invalidateQueries({ queryKey: catalogMappingKeys.profile(tenantKey) });
    void queryClient.invalidateQueries({ queryKey: catalogKeys.source(tenantKey) });
    void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(tenantKey) });
    // Prefix key: every filter/search combination of the product list.
    void queryClient.invalidateQueries({ queryKey: ["catalog", tenantKey, "products"] });
  };
}
