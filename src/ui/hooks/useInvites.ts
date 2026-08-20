"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type {
  CreateInviteResponse,
  InviteListResponse,
  RevokeInviteResponse,
} from "@/ui/schemas/invite.schema";
import type { MembershipRole } from "@/ui/schemas/me.schema";
import { ApiError } from "@/ui/services/api-error";
import { createInvite, inviteKeys, listInvites, revokeInvite } from "@/ui/services/invite.api";

/**
 * Logic layer of the invite links (M2.3), docs/07 §4.1.
 *
 * SECURITY: `useCreateInvite` hands the url back through the mutation result
 * only. It is deliberately NOT written into the query cache — the list query
 * has no url field, and putting one there would persist a credential in a
 * structure meant to be dumped, inspected and refetched.
 */

export function useInvites() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<InviteListResponse, ApiError>({
    queryKey: inviteKeys.list(tenantKey),
    queryFn: ({ signal }) => listInvites(signal),
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // Links expire on a clock, so a long-open tab must not keep calling a dead
    // one "đang mở".
    staleTime: 15_000,
  });
}

/** Never auto-retried: a second call mints a second live link. */
export function useCreateInvite() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<CreateInviteResponse, ApiError, { role: MembershipRole }>({
    mutationFn: ({ role }) => createInvite({ role }),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inviteKeys.list(tenantKey) });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<RevokeInviteResponse, ApiError, { inviteId: string }>({
    mutationFn: ({ inviteId }) => revokeInvite({ inviteId }),
    retry: false,
    onSettled: () => {
      // Also on failure: the link may already be revoked or spent, which is
      // exactly why the revoke failed.
      void queryClient.invalidateQueries({ queryKey: inviteKeys.list(tenantKey) });
    },
  });
}
