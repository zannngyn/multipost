"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type { CatalogProductsResponse } from "@/ui/schemas/catalog.schema";
import { ApiError } from "@/ui/services/api-error";
import { listCatalogProducts } from "@/ui/services/catalog.api";

/**
 * Type-ahead behind the "Mã sản phẩm" field (docs/07 §4.1: fetch policy lives
 * in the hook, transport in the service).
 *
 * It reuses `listCatalogProducts` rather than adding an endpoint — the compose
 * API contract is untouched by this screen's redesign.
 *
 * Decisions worth knowing:
 *  - `enabled` is driven by the caller, so a compose screen where the operator
 *    never opens the list makes NO request at all;
 *  - the search string is part of the query key, which is what makes the race
 *    impossible: typing again cancels the previous fetch instead of letting a
 *    slow answer overwrite a fast one (core-form-inputs §nạp bất đồng bộ);
 *  - the key deliberately does NOT collide with `catalogKeys.products`: that
 *    one belongs to an infinite query on the product screen, and two query
 *    types on one key corrupt each other's cache entry.
 */

/** Enough to scan without scrolling; the field itself is the way to narrow. */
const SUGGESTION_LIMIT = 8;

export function useProductSuggestions(query: string, enabled: boolean) {
  const { tenantKey, isResolved } = useActiveTenant();
  const q = query.trim();

  return useQuery<CatalogProductsResponse, ApiError>({
    queryKey: ["catalog", tenantKey, "product-suggestions", q],
    queryFn: ({ signal }) =>
      listCatalogProducts(
        { filter: { status: null, q: q.length > 0 ? q : null }, limit: SUGGESTION_LIMIT },
        signal,
      ),
    // Nothing is fetched until `/api/me` says which company we are in (M1.4).
    enabled: enabled && isResolved,
    // Keep the previous rows on screen while the next ones load: a dropdown
    // that blanks on every keystroke reads as broken.
    placeholderData: keepPreviousData,
    // The catalog only moves when a sync runs.
    staleTime: 30_000,
    // One retry, and only for errors where retrying can change the answer.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 1 : false,
  });
}
