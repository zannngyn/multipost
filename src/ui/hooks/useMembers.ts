"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type { MembershipRole } from "@/ui/schemas/me.schema";
import type { MemberListResponse } from "@/ui/schemas/member.schema";
import { ApiError } from "@/ui/services/api-error";
import { listMembers, memberKeys, removeMember, updateMemberRole } from "@/ui/services/member.api";
import { meKeys } from "@/ui/services/me.api";

/**
 * Logic layer of the "Thành viên" screen (M2.3), docs/07 §4.1.
 *
 * Writes are NEVER auto-retried: re-sending "gỡ thành viên" after a timeout
 * would act twice on a request the server may already have accepted.
 *
 * Every write also invalidates `/api/me` when it was about the operator
 * themselves: their own role decides what the whole app lets them do, so a
 * demotion that only refreshed this table would leave the rest of the UI
 * offering buttons the server now refuses (core-auth-session §10: a revoked
 * permission must reach the UI, not wait for the next 403).
 */

export function useMembers() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<MemberListResponse, ApiError>({
    queryKey: memberKeys.list(tenantKey),
    queryFn: ({ signal }) => listMembers(signal),
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // Somebody else may be changing roles from another browser; this is the
    // screen where acting on a stale row does real damage.
    staleTime: 15_000,
  });
}

export interface MemberMutationInput {
  membershipId: string;
  /** True when the row is the operator — decides whether /api/me is re-read. */
  isYou: boolean;
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<unknown, ApiError, MemberMutationInput & { role: MembershipRole }>({
    mutationFn: ({ membershipId, role }) => updateMemberRole({ membershipId, role }),
    retry: false,
    onSettled: (_data, _error, variables) => {
      // Also on failure: a 409 LAST_OWNER usually means somebody else changed
      // the same company a moment ago, and the table must show what the server
      // has rather than what this tab hoped for.
      void queryClient.invalidateQueries({ queryKey: memberKeys.list(tenantKey) });
      if (variables.isYou) void queryClient.invalidateQueries({ queryKey: meKeys.me() });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<unknown, ApiError, MemberMutationInput>({
    mutationFn: ({ membershipId }) => removeMember({ membershipId }),
    retry: false,
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.list(tenantKey) });
      // Removing YOURSELF ends the membership this screen is rendered under.
      // Re-reading /api/me is what makes `TenantBoundary` take over — picker or
      // onboarding, whichever is true now — instead of leaving a dead table on
      // screen that answers 404 to everything.
      if (variables.isYou) void queryClient.invalidateQueries({ queryKey: meKeys.me() });
    },
  });
}
