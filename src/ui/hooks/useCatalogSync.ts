"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { RunSyncResponse, SyncRunStatus, SyncStatusResponse } from "@/ui/schemas/sync.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError, CLIENT_ERROR_CODES } from "@/ui/services/api-error";
import { catalogKeys, fetchSyncStatus, runCatalogSync } from "@/ui/services/catalog.api";

/**
 * Logic layer for the sync screen (docs/07 §4.1): owns fetch policy and cache
 * invalidation, never the transport.
 *
 * The company is NOT a parameter any more (M1.4): the server reads it from the
 * session, and the UI reads it from `/api/me` — the hook only needs it to
 * partition the cache and to know when the answer can be asked for at all.
 */

const SYNC_MIN_POLL_MS = 3_000;
const SYNC_MAX_POLL_MS = 15_000;

/**
 * Past this age, a `running` row stops being treated as "almost done" and gets
 * the slow curve below instead of the fast one.
 *
 * NOT a death threshold. `maxDuration = 300` in the route only binds on
 * platforms that enforce it; this product ships self-hosted (Dockerfile runs
 * `node server.js`, Caddy in front), where a 300s proxy timeout kills the
 * CONNECTION and nothing else — the handler keeps walking Drive, because the
 * usecase takes no AbortSignal. A 5.500-file catalogue can legitimately run
 * past this mark and still be writing rows.
 */
const SYNC_FAST_POLL_MAX_AGE_MS = 330_000;

/** Old but possibly alive: ask rarely, keep the screen honest. */
const SYNC_SLOW_POLL_MS = 60_000;

/** While the query itself is failing — slow enough not to pile on, alive enough to recover. */
const SYNC_ERROR_POLL_MS = 30_000;

/**
 * The age past which a `running` row is treated as dead: the process was killed
 * mid-write and nobody will ever move that row again.
 *
 * Deliberately WIDE, and deliberately not derived from the route's
 * `maxDuration`: on self-hosted deployments nothing stops the handler at 300s,
 * so the only honest bound is "longer than any real sync could plausibly take".
 * Thirty minutes is a conservative estimate for the biggest catalogue we know
 * of (~5.500 files) — an ESTIMATE, not a measurement. If a real sync is ever
 * observed running longer, raise this rather than let the screen call a live
 * run dead.
 *
 * Two opposite hazards meet here, which is why the number is generous:
 * declaring a live run dead re-opens "Chạy đồng bộ" ON TOP of a run still
 * writing; never declaring it dead locks that button forever after a crash.
 */
const SYNC_RUN_HARD_MAX_AGE_MS = 30 * 60_000;

/**
 * Is the server still working on this run — as far as anyone can tell?
 *
 * The ONE definition of "đang chạy" for the screen's CONTROLS: the "Chạy đồng
 * bộ" button and the "vẫn đang chạy" banner both read this, so they cannot
 * disagree. `running` alone is not enough — a crashed process leaves that word
 * behind forever, and a button nobody can ever press again is its own outage.
 *
 * `nowMs` is a parameter rather than a `Date.now()` inside: the age guard is
 * the branch most worth testing, and a function that reads the clock itself
 * cannot be tested for it.
 */
export function isSyncRunLive(
  run: { status: SyncRunStatus; startedAt: string } | null | undefined,
  nowMs: number,
): boolean {
  if (!run) return false;
  if (run.status !== "running") return false;

  // A timestamp that does not parse means the age cannot be bounded, and
  // "unbounded" is exactly what this guard exists to prevent.
  const startedAtMs = Date.parse(run.startedAt);
  if (Number.isNaN(startedAtMs)) return false;

  // A negative age (client clock ahead of the server's) is skew, not a finished
  // run: `<=` keeps it live rather than declaring it dead the moment it starts.
  return nowMs - startedAtMs <= SYNC_RUN_HARD_MAX_AGE_MS;
}

/**
 * Poll interval while a sync run is open, or `false` to stop
 * (web-long-running-jobs rule 3).
 *
 * A sync IS a long-running job: it walks thousands of Drive files, it outlives
 * the request that started it, and `sync_run.status` is the server-side truth
 * about it. So the screen follows that status, not the mutation, in three
 * bands:
 *   young  (< 330s)      — adaptive 3s → 15s, the run is expected to land soon
 *   old    (330s – 30m)  — flat 60s, it may still be alive on a self-hosted box
 *   stuck  (> 30m)       — `false`, nobody is going to finish this row
 */
export function syncStatusPollInterval(
  data: SyncStatusResponse | undefined,
  updateCount: number,
  nowMs: number,
): number | false {
  // No answer yet, or a tenant that has never synced: nothing is running, so
  // there is nothing to watch.
  if (!data) return false;
  if (data.state !== "has_run") return false;
  if (!isSyncRunLive(data.run, nowMs)) return false;

  // Parsable: `isSyncRunLive` refused everything else.
  const ageMs = nowMs - Date.parse(data.run.startedAt);
  if (ageMs > SYNC_FAST_POLL_MAX_AGE_MS) return SYNC_SLOW_POLL_MS;

  // Clamped: a negative tick count would produce a negative interval, and
  // TanStack silently declines to set a timer for one (`isValidTimeout`
  // requires >= 0) — polling would die without a sound.
  const ticks = Math.max(0, updateCount);
  return Math.min(SYNC_MAX_POLL_MS, SYNC_MIN_POLL_MS + ticks * 1_000);
}

/**
 * One poll decision, including the two things the interval alone cannot know.
 *
 *  - `isError`: the fast curve on top of a 500 is a request storm. But `false`
 *    is worse: the operator is STARING at this screen, not blurring the tab, so
 *    focus-refetch never fires and one unlucky 500 would kill live updates
 *    until a manual reload. A flat 30s is the compromise.
 *  - `base`: `dataUpdateCount` counts every successful fetch for the LIFE of
 *    the query, so on a tab left open all day the first tick of a brand new run
 *    would already sit at the 15s ceiling. `base` anchors the curve at the
 *    start of each poll SESSION; `null` means "not polling right now".
 *
 * Returned rather than mutated so the whole decision stays pure and testable;
 * the hook only stores what comes back.
 */
export function nextSyncStatusPoll(input: {
  isError: boolean;
  data: SyncStatusResponse | undefined;
  updateCount: number;
  base: number | null;
  nowMs: number;
}): { interval: number | false; base: number | null } {
  // Anchor dropped as well: recovery should start at the fast end of the curve.
  if (input.isError) return { interval: SYNC_ERROR_POLL_MS, base: null };

  // `Math.max(0)` is a seatbelt, not decoration: `base` and `updateCount` come
  // from two different lifetimes (a ref vs. the Query object), and a negative
  // elapsed used to travel all the way into a negative interval.
  const elapsed = input.base === null ? 0 : Math.max(0, input.updateCount - input.base);
  const interval = syncStatusPollInterval(input.data, elapsed, input.nowMs);
  // Session over (run settled, or too old to be believed): forget the anchor so
  // the next run starts its curve at the fast end again.
  if (interval === false) return { interval: false, base: null };

  return { interval, base: input.base ?? input.updateCount };
}

/**
 * True when the run request gave up on OUR side rather than the server
 * reporting a failed sync.
 *
 * This matters because the two look identical to a mutation: `runCatalogSync`
 * gives up at 120s while the route keeps walking Drive inline — nothing on a
 * self-hosted box interrupts that handler — so a big catalogue reliably
 * produces this error WHILE the sync is still writing rows. Calling that "đồng
 * bộ thất bại" is a lie, and the retry button next to it would start a second
 * run on top of the first.
 *
 * Deliberately ONE code (`TIMEOUT`, set by `http-client` when the abort came
 * from `AbortSignal.timeout`): `NETWORK_ERROR` covers the offline case where no
 * request ever reached the server, and a real `SHEET_ERROR` must keep looking
 * like the failure it is.
 */
export function isSyncStillRunningError(error: unknown): boolean {
  return ApiError.is(error) && error.code === CLIENT_ERROR_CODES.TIMEOUT;
}

export function useSyncStatus() {
  const { tenantKey, isResolved } = useActiveTenant();
  /**
   * Anchor of the current poll session — see `nextSyncStatusPoll`.
   *
   * Keyed by `queryHash` because the ref and the counter it is compared against
   * have different lifetimes: the ref belongs to this hook instance, while
   * `dataUpdateCount` belongs to the Query object, which is swapped out when
   * the key changes (a different company) WITHOUT remounting the hook. An
   * anchor left over from the previous query is measured against a counter that
   * never knew it — the arithmetic then produces a nonsense elapsed, in either
   * direction. Different hash, fresh session.
   */
  const pollAnchorRef = useRef<{ queryHash: string; base: number | null }>({
    queryHash: "",
    base: null,
  });

  return useQuery<SyncStatusResponse, ApiError>({
    queryKey: catalogKeys.syncStatus(tenantKey),
    queryFn: ({ signal }) => fetchSyncStatus(signal),
    enabled: isResolved,
    // 4xx means the request itself is wrong — retrying repeats the mistake.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchInterval: (query) => {
      const anchor = pollAnchorRef.current;
      const next = nextSyncStatusPoll({
        isError: query.state.status === "error",
        data: query.state.data,
        updateCount: query.state.dataUpdateCount ?? 0,
        base: anchor.queryHash === query.queryHash ? anchor.base : null,
        nowMs: Date.now(),
      });
      pollAnchorRef.current = { queryHash: query.queryHash, base: next.base };
      return next.interval;
    },
    // A hidden tab polls nothing; it asks once when it comes back into focus.
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

export function useRunCatalogSync() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<RunSyncResponse, ApiError, void>({
    mutationFn: () => runCatalogSync(),
    // A write is never retried automatically: a sync that half-ran must not be
    // silently started a second time.
    retry: false,
    onSettled: () => {
      // Every outcome ends here, including the client timeout:
      //  - a failed run wrote a `failed` sync_run row, and the panel must show
      //    it instead of the previous success;
      //  - a timed-out request left a run that is very likely still `running`,
      //    and this invalidation is what hands the screen back to the server's
      //    own status — `syncStatusPollInterval` then follows it to the end.
      // The error is NOT swallowed either way: the screen still renders it, it
      // just words a timeout as "vẫn đang chạy" rather than "thất bại".
      void queryClient.invalidateQueries({ queryKey: catalogKeys.syncStatus(tenantKey) });
    },
  });
}
