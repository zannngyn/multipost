"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChannelImportResponse,
  ChannelListResponse,
  ChannelStatus,
  RemoveChannelResponse,
  SetChannelStatusResponse,
} from "@/ui/schemas/channel.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import {
  channelKeys,
  importChannels,
  listChannels,
  refreshChannels,
  removeChannel,
  setChannelStatus,
} from "@/ui/services/channel.api";

/**
 * Logic layer of the "Kênh" screen (E5.1), docs/07 §4.1.
 *
 * One query key for the tenant's Pages, so importing on /channels also fixes
 * the picker on /channels/groups without a reload (core-component-reuse: share
 * the rule, not just the widget).
 *
 * Writes are NEVER auto-retried. Re-sending "gỡ kênh" or "import token" after a
 * timeout would act twice on a request the server may already have accepted.
 */

export function useChannels() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<ChannelListResponse, ApiError>({
    queryKey: channelKeys.list(tenantKey),
    queryFn: ({ signal }) => listChannels(signal),
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}

export function useSetChannelStatus() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<SetChannelStatusResponse, ApiError, { channelId: string; status: ChannelStatus }>(
    {
      mutationFn: (input) => setChannelStatus(input),
      retry: false,
      onSettled: () => {
        // Also on failure: another operator may have changed the same channel,
        // and the screen must show what the server has, not what it hoped for.
        void queryClient.invalidateQueries({ queryKey: channelKeys.list(tenantKey) });
      },
    },
  );
}

export function useRemoveChannel() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<RemoveChannelResponse, ApiError, { channelId: string }>({
    mutationFn: ({ channelId }) => removeChannel({ channelId }),
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list(tenantKey) });
    },
  });
}

/**
 * Exchanges a pasted User Access Token for the tenant's Pages.
 *
 * SECURITY: the token is passed as a mutation variable, which lives in memory
 * only — never a query key, so it cannot end up in a cache dump or devtools
 * key list. The caller resets this mutation right after success so the value
 * does not linger in the mutation cache (see `ChannelConnectPanel`).
 */
export function useImportChannels() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ChannelImportResponse, ApiError, { userAccessToken: string }>({
    mutationFn: ({ userAccessToken }) => importChannels({ userAccessToken }),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list(tenantKey) });
    },
  });
}

/** Re-reads the Pages with the token the server already stored. */
export function useRefreshChannels() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ChannelImportResponse, ApiError, void>({
    mutationFn: () => refreshChannels(),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list(tenantKey) });
    },
  });
}
