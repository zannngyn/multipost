"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChannelGroup,
  ChannelGroupListResponse,
  DeleteChannelGroupResponse,
} from "@/ui/schemas/channel-group.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import {
  channelGroupKeys,
  createChannelGroup,
  deleteChannelGroup,
  listChannelGroups,
  updateChannelGroup,
} from "@/ui/services/channel-group.api";

/**
 * Logic layer of the preset channel groups (E7.6 / E10.3), docs/07 §4.1.
 * Shared by the /channels/groups screen (CRUD) and by the wizard's channel
 * picker — one query key, so creating a group there shows up in the wizard
 * without a reload (core-component-reuse: share the rule, not just the widget).
 */

export function useChannelGroups() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<ChannelGroupListResponse, ApiError>({
    queryKey: channelGroupKeys.list(tenantKey),
    queryFn: ({ signal }) => listChannelGroups(signal),
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}

export interface ChannelGroupInput {
  name: string;
  channelIds: readonly string[];
}

/** Writes are never auto-retried: a duplicated group is a silent mess. */
export function useCreateChannelGroup() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ChannelGroup, ApiError, ChannelGroupInput>({
    mutationFn: (input) => createChannelGroup(input),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantKey) });
    },
  });
}

export function useUpdateChannelGroup() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ChannelGroup, ApiError, ChannelGroupInput & { groupId: string }>({
    mutationFn: (input) => updateChannelGroup(input),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantKey) });
    },
  });
}

export function useDeleteChannelGroup() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<DeleteChannelGroupResponse, ApiError, { groupId: string }>({
    mutationFn: ({ groupId }) => deleteChannelGroup({ groupId }),
    retry: false,
    onSettled: () => {
      // Also on failure: the group may be gone already (another operator), and
      // the screen must show what the server has, not what it hoped for.
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantKey) });
    },
  });
}
