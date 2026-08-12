"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import {
  JOB_LOG_DEFAULT_LIMIT,
  type JobLogFilter,
  type PostJobLogResponse,
  type RetryPostJobResponse,
} from "@/ui/schemas/post-batch.schema";
import { ApiError } from "@/ui/services/api-error";
import { listPostJobs, postKeys, retryPostJob } from "@/ui/services/post.api";

/**
 * Logic layer of the job log (E11.1), docs/07 §4.1.
 *
 * Cursor pagination (core-data-list-query): the worker keeps writing while the
 * operator reads, so an offset page would skip or duplicate rows. "Tải thêm"
 * appends a page; there is deliberately no "nhảy tới trang 7" — a cursor cannot
 * do it, and pretending otherwise breaks the moment someone tries.
 */

export function usePostJobLog(tenantId: string, filter: JobLogFilter) {
  return useInfiniteQuery<PostJobLogResponse, ApiError>({
    queryKey: postKeys.jobs(tenantId, filter),
    queryFn: ({ pageParam, signal }) =>
      listPostJobs(
        {
          tenantId,
          status: filter.status,
          batchId: filter.batchId,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: JOB_LOG_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: tenantId.length > 0,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // The log is an audit view: 10s is short enough to feel live, long enough
    // not to refetch on every re-render of a busy screen.
    staleTime: 10_000,
  });
}

/**
 * Re-queues one job. Never retried automatically — a retry of a retry would
 * queue the same post twice; and a 409 (đã đăng rồi) must stay a 409.
 */
export function useRetryPostJob(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation<RetryPostJobResponse, ApiError, { postJobId: string }>({
    mutationFn: ({ postJobId }) => retryPostJob({ tenantId, postJobId }),
    retry: false,
    onSettled: (result) => {
      // Even a refusal must refresh the list: the row may have moved because
      // somebody else acted on it, which is exactly why the retry failed.
      void queryClient.invalidateQueries({ queryKey: ["posts", tenantId, "jobs"] });
      if (result) {
        void queryClient.invalidateQueries({
          queryKey: postKeys.batch(tenantId, result.batchId),
        });
      }
    },
  });
}
