"use client";

import { useQuery } from "@tanstack/react-query";

import type { WorkerHealth } from "@/ui/schemas/worker-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchWorkerHealth, postKeys } from "@/ui/services/post.api";

/**
 * Logic layer of the "máy đăng bài có chạy không?" banner (docs/07 §4.1).
 *
 * Polling, not a socket: the UI reads state from the database through the
 * internal API and holds no long-lived connection (E10 rule 5). 30s is short
 * enough that an operator who just restarted the worker sees the banner clear
 * on its own, and cheap enough to leave running on an open tab.
 */
const POLL_INTERVAL_MS = 30_000;

export function useWorkerHealth(tenantId: string) {
  return useQuery<WorkerHealth, ApiError>({
    queryKey: postKeys.workerHealth(tenantId),
    queryFn: ({ signal }) => fetchWorkerHealth({ tenantId }, signal),
    enabled: tenantId.length > 0,
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchInterval: POLL_INTERVAL_MS,
    // Keep polling in a background tab: an operator who leaves the log open on
    // a second screen is exactly who this banner is for.
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
