"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChannelGroup,
  ChannelGroupListResponse,
  DeleteChannelGroupResponse,
} from "@/ui/schemas/channel-group.schema";
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
 * Shared by the /channels screen (CRUD) and by the wizard's channel picker —
 * one query key, so creating a group on /channels shows up in the wizard
 * without a reload (core-component-reuse: share the rule, not just the widget).
 */

export function useChannelGroups(tenantId: string) {
  return useQuery<ChannelGroupListResponse, ApiError>({
    queryKey: channelGroupKeys.list(tenantId),
    queryFn: ({ signal }) => listChannelGroups(tenantId, signal),
    enabled: tenantId.length > 0,
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
export function useCreateChannelGroup(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation<ChannelGroup, ApiError, ChannelGroupInput>({
    mutationFn: (input) => createChannelGroup({ tenantId, ...input }),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantId) });
    },
  });
}

export function useUpdateChannelGroup(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation<ChannelGroup, ApiError, ChannelGroupInput & { groupId: string }>({
    mutationFn: (input) => updateChannelGroup({ tenantId, ...input }),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantId) });
    },
  });
}

export function useDeleteChannelGroup(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation<DeleteChannelGroupResponse, ApiError, { groupId: string }>({
    mutationFn: ({ groupId }) => deleteChannelGroup({ tenantId, groupId }),
    retry: false,
    onSettled: () => {
      // Also on failure: the group may be gone already (another operator), and
      // the screen must show what the server has, not what it hoped for.
      void queryClient.invalidateQueries({ queryKey: channelGroupKeys.list(tenantId) });
    },
  });
}
