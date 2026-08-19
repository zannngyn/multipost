"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isSettledBatchStatus, type BatchStatusResponse } from "@/ui/schemas/post-batch.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  createPostBatch,
  fetchBatchStatus,
  postKeys,
  type CreatePostBatchParams,
} from "@/ui/services/post.api";
import type { CreateBatchResponse } from "@/ui/schemas/post-batch.schema";

/**
 * Logic layer of the publish flow (docs/07 §4.1): fetch policy and cache
 * invalidation live here, never in a component and never in the transport.
 *
 * Polling contract (core-long-running-jobs + web-long-running-jobs rule 3):
 *  - the batch is a SERVER resource with its own URL, so closing the tab does
 *    not stop it and reopening `/batches/<id>` shows the truth;
 *  - the interval backs off 3s → 5s → 8s (cap) instead of hammering at a fixed
 *    rate, and returns `false` the moment the batch is settled — forgetting
 *    that is how a page polls forever;
 *  - a hidden tab does not poll (`refetchIntervalInBackground: false`).
 *
 * ONE exception to the backoff (design §4.2): while a job is actually
 * `publishing`, its row shows a per-stage stepper and a photo counter, and a
 * count that lands 8s late is a count the operator has already stopped
 * trusting. That window is short and bounded by the publish itself, so it gets
 * a flat fast interval instead of a backoff. Everything else — including a
 * batch merely sitting in the queue, where a batch spends most of its life —
 * keeps the old curve.
 */

const MIN_POLL_MS = 3_000;
const MAX_POLL_MS = 8_000;
/** Flat, and deliberately NOT backed off: see the exception above. */
const ACTIVE_POLL_MS = 1_500;

export function batchPollInterval(
  data: BatchStatusResponse | undefined,
  updateCount: number,
): number | false {
  // No data yet (first load or an error): let the query's own retry policy work.
  if (!data) return false;
  if (isSettledBatchStatus(data.status)) return false;
  // Read from the rows rather than `totals.publishing`: the rows are what carry
  // the progress block, so the thing refreshed is the thing counted.
  if (data.channels.some((channel) => channel.status === "publishing")) return ACTIVE_POLL_MS;
  return Math.min(MAX_POLL_MS, MIN_POLL_MS + updateCount * 1_000);
}

export function useBatchStatus(tenantId: string, batchId: string) {
  return useQuery<BatchStatusResponse, ApiError>({
    queryKey: postKeys.batch(tenantId, batchId),
    queryFn: ({ signal }) => fetchBatchStatus(tenantId, batchId, signal),
    enabled: tenantId.length > 0 && batchId.length > 0,
    // 4xx (batch không tồn tại) repeats the same mistake — do not retry it.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchInterval: (query) =>
      batchPollInterval(query.state.data, query.state.dataUpdateCount ?? 0),
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/**
 * Creates a batch. `retry: false` on purpose: without an explicit batch id a
 * second call is a second fan-out, i.e. the same product posted twice.
 */
export function useCreatePostBatch() {
  const queryClient = useQueryClient();

  return useMutation<CreateBatchResponse, ApiError, CreatePostBatchParams>({
    mutationFn: (params) => createPostBatch(params),
    retry: false,
    onSuccess: (result) => {
      // Seed nothing, invalidate everything the new jobs appear in: the log is
      // the audit trail and must not keep showing the state before this batch.
      void queryClient.invalidateQueries({ queryKey: ["posts", result.tenantId, "jobs"] });
    },
  });
}
