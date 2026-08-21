"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
  JOB_LOG_DEFAULT_LIMIT,
  type JobLogFilter,
  type PostJobLogResponse,
  type PostJobStatus,
  type RetryPostJobResponse,
} from "@/ui/schemas/post-batch.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import { listPostJobs, postKeys, retryPostJob } from "@/ui/services/post.api";

/**
 * Logic layer of the job log (E11.1), docs/07 §4.1.
 *
 * Cursor pagination (core-data-list-query): the worker keeps writing while the
 * operator reads, so an offset page would skip or duplicate rows. "Tải thêm"
 * appends a page; there is deliberately no "nhảy tới trang 7" — a cursor cannot
 * do it, and pretending otherwise breaks the moment someone tries.
 *
 * Polling (core-long-running-jobs + web-long-running-jobs rule 3): the log is
 * the screen an operator watches while a batch drains, so it follows the same
 * contract as the batch page — back off instead of hammering, and return
 * `false` the moment nothing is moving. A log of finished jobs polls NOTHING;
 * forgetting that turns every open tab into a permanent request source.
 */

const JOB_LOG_MIN_POLL_MS = 2_000;
const JOB_LOG_MAX_POLL_MS = 15_000;

/** While the query itself is failing — slow enough not to pile on, alive enough to recover. */
const JOB_LOG_ERROR_POLL_MS = 30_000;

/**
 * Statuses a worker is still going to move on its own. Deliberately NOT the
 * inverse of `isSettledJobStatus`: `draft` waits for a person, and
 * `scheduled_on_facebook` waits for the reconciliation sweep hours later —
 * polling either one every two seconds asks a question whose answer cannot
 * change in that window.
 */
const ACTIVE_JOB_STATUSES: readonly PostJobStatus[] = ["queued", "publishing"];

/**
 * Poll interval for the loaded pages, or `false` to stop.
 *
 * Reads the pages already in the cache rather than a counter from the server:
 * the rows on screen are what the operator is waiting on, so the thing polled
 * is the thing shown. A filter that hides the active jobs therefore stops
 * polling too — correct, since that view has nothing to refresh.
 */
export function jobLogPollInterval(
  pages: readonly PostJobLogResponse[] | undefined,
  updateCount: number,
): number | false {
  // Nothing loaded yet (first load or an error): the query's own retry policy
  // owns that window, a poll here would race it.
  if (!pages || pages.length === 0) return false;

  const hasActive = pages.some((page) =>
    page.items.some((item) => ACTIVE_JOB_STATUSES.includes(item.status)),
  );
  if (!hasActive) return false;

  // Clamped: a negative tick count would produce a negative interval, and
  // TanStack silently declines to set a timer for one (`isValidTimeout`
  // requires >= 0) — polling would die without a sound.
  const ticks = Math.max(0, updateCount);
  return Math.min(JOB_LOG_MAX_POLL_MS, JOB_LOG_MIN_POLL_MS + ticks * 1_000);
}

/**
 * One poll decision, including the two things the interval alone cannot know.
 *
 *  - `isError`: the fast curve on top of a 500 is a request storm. But `false`
 *    is worse: the operator is STARING at this screen while a batch drains, not
 *    blurring the tab, so focus-refetch never fires and one unlucky 500 would
 *    kill live updates until a manual reload. A flat 30s is the compromise.
 *  - `base`: `dataUpdateCount` counts every successful fetch for the LIFE of
 *    the query, so on a tab left open all day the first tick of a brand new
 *    batch would already sit at the 15s ceiling — the opposite of what a log
 *    watched during a publish is for. `base` anchors the curve at the start of
 *    each poll SESSION; `null` means "not polling right now".
 *
 * Returned rather than mutated so the whole decision stays pure and testable;
 * the hook only stores what comes back.
 */
export function nextJobLogPoll(input: {
  isError: boolean;
  pages: readonly PostJobLogResponse[] | undefined;
  updateCount: number;
  base: number | null;
}): { interval: number | false; base: number | null } {
  // Anchor dropped as well: recovery should start at the fast end of the curve.
  if (input.isError) return { interval: JOB_LOG_ERROR_POLL_MS, base: null };

  // `Math.max(0)` is a seatbelt, not decoration: `base` and `updateCount` come
  // from two different lifetimes (a ref vs. the Query object), and a negative
  // elapsed used to travel all the way into a negative interval.
  const elapsed = input.base === null ? 0 : Math.max(0, input.updateCount - input.base);
  const interval = jobLogPollInterval(input.pages, elapsed);
  // Session over (nothing active any more): forget the anchor, so the next
  // batch starts its curve at the fast end again.
  if (interval === false) return { interval: false, base: null };

  return { interval, base: input.base ?? input.updateCount };
}

export function usePostJobLog(filter: JobLogFilter) {
  const { tenantKey, isResolved } = useActiveTenant();
  /**
   * Anchor of the current poll session — see `nextJobLogPoll`.
   *
   * Keyed by `queryHash` because the ref and the counter it is compared against
   * have different lifetimes. This screen is the proof: changing the status
   * filter rewrites the URL, which changes `queryKey`, which swaps the Query
   * object — while this hook keeps its ref. An anchor from the previous filter
   * measured against the new query's `dataUpdateCount` produces a nonsense
   * elapsed in either direction (negative → no timer set at all, or far too
   * large → straight to the ceiling). Different hash, fresh session.
   */
  const pollAnchorRef = useRef<{ queryHash: string; base: number | null }>({
    queryHash: "",
    base: null,
  });

  return useInfiniteQuery<PostJobLogResponse, ApiError>({
    queryKey: postKeys.jobs(tenantKey, filter),
    queryFn: ({ pageParam, signal }) =>
      listPostJobs(
        {
          status: filter.status,
          batchId: filter.batchId,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: JOB_LOG_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    /**
     * No `maxPages` on purpose, even though a poll refetches every loaded page.
     * `maxPages: 3` would make the 4th "Tải thêm" DROP page 1 — and page 1 here
     * is the NEWEST rows (cursor pagination, newest first), which
     * `JobLogScreen` flattens straight into the table. The operator would press
     * "Tải thêm" and watch the top of an audit log disappear. Cost of the
     * refetch is bounded by how many pages someone actually opened, and the
     * poll only runs while jobs are moving.
     */
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchInterval: (query) => {
      const anchor = pollAnchorRef.current;
      const next = nextJobLogPoll({
        isError: query.state.status === "error",
        pages: query.state.data?.pages,
        updateCount: query.state.dataUpdateCount ?? 0,
        base: anchor.queryHash === query.queryHash ? anchor.base : null,
      });
      pollAnchorRef.current = { queryHash: query.queryHash, base: next.base };
      return next.interval;
    },
    // A hidden tab polls nothing; it asks once when it comes back into focus.
    refetchIntervalInBackground: false,
    // The log is an audit view: 10s is short enough to feel live, long enough
    // not to refetch on every re-render of a busy screen.
    staleTime: 10_000,
  });
}

/**
 * Re-queues one job. Never retried automatically — a retry of a retry would
 * queue the same post twice; and a 409 (đã đăng rồi) must stay a 409.
 */
export function useRetryPostJob() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<RetryPostJobResponse, ApiError, { postJobId: string }>({
    mutationFn: ({ postJobId }) => retryPostJob({ postJobId }),
    retry: false,
    onSettled: (result) => {
      // Even a refusal must refresh the list: the row may have moved because
      // somebody else acted on it, which is exactly why the retry failed.
      void queryClient.invalidateQueries({ queryKey: ["posts", tenantKey, "jobs"] });
      if (result) {
        void queryClient.invalidateQueries({
          queryKey: postKeys.batch(tenantKey, result.batchId),
        });
      }
    },
  });
}
