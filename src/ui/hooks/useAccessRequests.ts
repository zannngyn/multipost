"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AccessDecision,
  AccessDecisionResponse,
  AccessFilterStatus,
  AccessRequestListResponse,
  AccessRole,
} from "@/ui/schemas/access-request.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  accessRequestKeys,
  decideAccessRequest,
  listAccessRequests,
} from "@/ui/services/access-request.api";

/**
 * Logic layer of the "Quyền truy cập" screen (E10), docs/07 §4.1.
 *
 * The filter is part of the query key, so switching tabs is a different query —
 * and `keepPreviousData` keeps the rows of the previous filter on screen while
 * the new answer arrives, instead of flashing back to a skeleton
 * (core-data-list-query §Hiệu năng).
 *
 * The decision is NEVER auto-retried: re-sending "chặn" after a timeout would
 * act twice on a request the server may already have accepted.
 */

export function useAccessRequests(tenantId: string, status: AccessFilterStatus) {
  return useQuery<AccessRequestListResponse, ApiError>({
    queryKey: accessRequestKeys.list(tenantId, status),
    queryFn: ({ signal }) => listAccessRequests(tenantId, status, signal),
    enabled: tenantId.length > 0,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    placeholderData: keepPreviousData,
    // Short: someone else may be approving from another browser, and an admin
    // acting on a stale row is exactly what this screen exists to prevent.
    staleTime: 15_000,
  });
}

export interface AccessDecisionInput {
  id: string;
  decision: AccessDecision;
  /** Only meaningful for "approve"; ignored by the service otherwise. */
  role?: AccessRole;
}

export function useDecideAccessRequest(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation<AccessDecisionResponse, ApiError, AccessDecisionInput>({
    mutationFn: (input) => decideAccessRequest({ tenantId, ...input }),
    retry: false,
    onSettled: () => {
      // Every filter, not just the one on screen: an approval moves a row from
      // "Chờ duyệt" to "Đã duyệt", so both lists are now wrong.
      //
      // Also on failure: another admin may have decided the same request a
      // second earlier, and the screen must show what the server has rather
      // than what this tab hoped for.
      void queryClient.invalidateQueries({ queryKey: accessRequestKeys.all(tenantId) });
    },
  });
}
