"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  PRODUCTS_DEFAULT_LIMIT,
  type CatalogProductsResponse,
  type CatalogSourceResponse,
  type ProductFilter,
  type UploadCatalogFileResponse,
} from "@/ui/schemas/catalog.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import {
  catalogKeys,
  fetchCatalogSource,
  listCatalogProducts,
  updateCatalogSource,
  uploadCatalogFile,
  type UpdateCatalogSourceParams,
  type UploadCatalogFileParams,
} from "@/ui/services/catalog.api";

/**
 * Logic layer of the "Nguồn dữ liệu" card and the "Sản phẩm" screen
 * (docs/07 §4.1): fetch policy and cache keys live here, transport does not.
 */

/** Nothing is fetched until `/api/me` says which company we are in (M1.4). */
export function useCatalogSource() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<CatalogSourceResponse, ApiError>({
    queryKey: catalogKeys.source(tenantKey),
    queryFn: ({ signal }) => fetchCatalogSource(signal),
    enabled: isResolved,
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // Configuration changes about as often as a deploy does.
    staleTime: 60_000,
  });
}

/**
 * Changes the tenant's source. Not retried automatically (it is a write), and
 * on success it invalidates everything that was derived from the OLD source:
 * the source card itself, the last sync run and the product list. Leaving the
 * product table on screen after the source changed would show 299 codes that
 * came from a folder nobody reads any more.
 */
export function useUpdateCatalogSource() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  // The variables type is the SERVICE's, not the source form's: the mapping step
  // saves through this same mutation and sends `fieldMap`/`stockPolicy` with the
  // three coordinates. The form still passes exactly what it always did.
  return useMutation<CatalogSourceResponse, ApiError, UpdateCatalogSourceParams>({
    mutationFn: (values) => updateCatalogSource(values),
    retry: false,
    onSuccess: (result) => {
      // Write the fresh source straight into the cache so the card cannot
      // flash the previous folder while the refetch is in flight.
      queryClient.setQueryData(catalogKeys.source(tenantKey), result);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.source(tenantKey) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(tenantKey) });
      // Prefix key: every filter/search combination of the product list.
      void queryClient.invalidateQueries({ queryKey: ["catalog", tenantKey, "products"] });
    },
  });
}

/**
 * Onboarding phase 3 — upload the tenant's product table as a CSV.
 *
 * A WRITE, and a heavy one: it replaces the source every later sync reads. Never
 * retried automatically, for the reason every write on this screen is not — a
 * call that half-applied must not be repeated behind the operator's back.
 *
 * On success it invalidates exactly what the update mutation does, plus the
 * compatibility report: every number in that report was measured against the
 * PREVIOUS table, and leaving it on screen would tell the operator their new
 * file has 299 usable codes when nobody has read it yet.
 *
 * What it does NOT do is touch the product list beyond invalidating it: the
 * catalog is not rewritten until somebody runs a sync, and the screen says so
 * rather than implying the upload imported anything.
 */
export function useUploadCatalogFile() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<UploadCatalogFileResponse, ApiError, UploadCatalogFileParams>({
    mutationFn: (params) => uploadCatalogFile(params),
    retry: false,
    onSuccess: (result) => {
      // The response carries the source AFTER the save, in the same shape a GET
      // returns — write it straight in so the card cannot flash the old source
      // while the refetch is in flight.
      queryClient.setQueryData(catalogKeys.source(tenantKey), {
        state: "configured" as const,
        tenantId: tenantKey,
        source: result.source,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.source(tenantKey) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(tenantKey) });
      // The report described the table this upload just replaced.
      void queryClient.invalidateQueries({ queryKey: ["catalog", tenantKey, "profile"] });
      // Prefix key: every filter/search combination of the product list.
      void queryClient.invalidateQueries({ queryKey: ["catalog", tenantKey, "products"] });
    },
  });
}

/**
 * Cursor pagination (core-data-list-query): the catalog is rewritten by every
 * sync, so an offset page would skip or repeat codes. "Tải thêm" appends a
 * page; there is deliberately no "nhảy tới trang 7" — a cursor cannot do it.
 *
 * The query key comes from the same `filter` object the URL produced, so
 * changing a filter starts a new list instead of appending to the old one.
 */
export function useCatalogProducts(filter: ProductFilter) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useInfiniteQuery<CatalogProductsResponse, ApiError>({
    // The company is part of the key, so switching company starts a NEW list:
    // a cursor minted for company A can never be replayed against company B
    // (docs/11 §4).
    queryKey: catalogKeys.products(tenantKey, filter),
    queryFn: ({ pageParam, signal }) =>
      listCatalogProducts(
        {
          filter,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: PRODUCTS_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // The catalog only moves when a sync runs; 30s keeps typing responsive
    // without re-querying on every keystroke that lands on the same filter.
    staleTime: 30_000,
  });
}
