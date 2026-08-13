"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  PRODUCTS_DEFAULT_LIMIT,
  type CatalogProductsResponse,
  type CatalogSourceResponse,
  type CatalogSourceFormValues,
  type ProductFilter,
} from "@/ui/schemas/catalog.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  catalogKeys,
  fetchCatalogSource,
  listCatalogProducts,
  updateCatalogSource,
} from "@/ui/services/catalog.api";

/**
 * Logic layer of the "Nguồn dữ liệu" card and the "Sản phẩm" screen
 * (docs/07 §4.1): fetch policy and cache keys live here, transport does not.
 */

/** `tenantId === null` = no tenant picked yet (idle), so nothing is fetched. */
export function useCatalogSource(tenantId: string | null) {
  return useQuery<CatalogSourceResponse, ApiError>({
    queryKey: catalogKeys.source(tenantId ?? "none"),
    queryFn: ({ signal }) => fetchCatalogSource(tenantId ?? "", signal),
    enabled: tenantId !== null,
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
export function useUpdateCatalogSource(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation<CatalogSourceResponse, ApiError, CatalogSourceFormValues>({
    mutationFn: (values) => updateCatalogSource({ tenantId: tenantId ?? "", ...values }),
    retry: false,
    onSuccess: (result) => {
      // Write the fresh source straight into the cache so the card cannot
      // flash the previous folder while the refetch is in flight.
      queryClient.setQueryData(catalogKeys.source(tenantId ?? "none"), result);
    },
    onSettled: () => {
      const id = tenantId ?? "none";
      void queryClient.invalidateQueries({ queryKey: catalogKeys.source(id) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(id) });
      // Prefix key: every filter/search combination of the product list.
      void queryClient.invalidateQueries({ queryKey: ["catalog", id, "products"] });
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
export function useCatalogProducts(tenantId: string, filter: ProductFilter) {
  return useInfiniteQuery<CatalogProductsResponse, ApiError>({
    queryKey: catalogKeys.products(tenantId, filter),
    queryFn: ({ pageParam, signal }) =>
      listCatalogProducts(
        {
          tenantId,
          filter,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: PRODUCTS_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: tenantId.length > 0,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // The catalog only moves when a sync runs; 30s keeps typing responsive
    // without re-querying on every keystroke that lands on the same filter.
    staleTime: 30_000,
  });
}
