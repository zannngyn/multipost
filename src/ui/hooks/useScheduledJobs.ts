"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import {
  SCHEDULED_DEFAULT_LIMIT,
  type CancelScheduledJobResponse,
  type RescheduleJobResponse,
  type ScheduledFilter,
  type ScheduledJobsResponse,
} from "@/ui/schemas/scheduled.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  cancelScheduledJob,
  listScheduledJobs,
  reschedulePostJob,
  scheduledKeys,
} from "@/ui/services/scheduled.api";

/**
 * Logic layer of "Bài đã hẹn" (E8.4), docs/07 §4.1: fetch policy and cache
 * invalidation live here, never in a component and never in the transport.
 *
 * Cursor pagination (core-data-list-query): the worker keeps publishing while
 * the operator reads, so an offset page would skip or duplicate rows.
 */

/**
 * The countdown on screen is computed from an absolute instant, but the row's
 * `canReschedule`/`canCancel` come from the SERVER — so the list has to come
 * back regularly or the buttons would outlive the hour they belong to.
 */
const SCHEDULED_REFETCH_MS = 60_000;

export function useScheduledJobs(tenantId: string, filter: ScheduledFilter) {
  return useInfiniteQuery<ScheduledJobsResponse, ApiError>({
    queryKey: scheduledKeys.list(tenantId, filter),
    queryFn: ({ pageParam, signal }) =>
      listScheduledJobs(
        {
          tenantId,
          filter,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: SCHEDULED_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: tenantId.length > 0,
    // A 4xx repeats the same bad filter — only transport/server errors retry.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
    refetchInterval: SCHEDULED_REFETCH_MS,
    // A tab left open in the background must not poll for hours.
    refetchIntervalInBackground: false,
  });
}

/**
 * Both mutations invalidate on SETTLED, not only on success: a refusal usually
 * means the row moved (a worker claimed it, somebody else cancelled it), which
 * is exactly the state the operator now needs to see.
 */
function useScheduledMutationInvalidation(tenantId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: scheduledKeys.all(tenantId) });
    // The job log is the audit view of the same rows; a cancelled post has to
    // show up there as `blocked` immediately.
    void queryClient.invalidateQueries({ queryKey: ["posts", tenantId, "jobs"] });
  };
}

export function useReschedulePostJob(tenantId: string) {
  const invalidate = useScheduledMutationInvalidation(tenantId);

  return useMutation<
    RescheduleJobResponse,
    ApiError,
    { postJobId: string; scheduledAt: string }
  >({
    mutationFn: ({ postJobId, scheduledAt }) =>
      reschedulePostJob({ tenantId, postJobId, scheduledAt }),
    // Never automatic: QUEUE_ERROR means the row already changed, and a blind
    // retry would enqueue the same post a second time.
    retry: false,
    onSettled: invalidate,
  });
}

export function useCancelScheduledJob(tenantId: string) {
  const invalidate = useScheduledMutationInvalidation(tenantId);

  return useMutation<CancelScheduledJobResponse, ApiError, { postJobId: string; note?: string }>({
    mutationFn: ({ postJobId, note }) => cancelScheduledJob({ tenantId, postJobId, note }),
    retry: false,
    onSettled: invalidate,
  });
}
