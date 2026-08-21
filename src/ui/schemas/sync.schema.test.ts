import { describe, expect, it } from "vitest";

import {
  isSyncRunLive,
  isSyncStillRunningError,
  nextSyncStatusPoll,
  syncStatusPollInterval,
} from "@/ui/hooks/useCatalogSync";
import { ApiError, CLIENT_ERROR_CODES } from "@/ui/services/api-error";

import {
  SYNC_STATUS_HINTS,
  SYNC_STATUS_LABELS,
  SyncRunSchema,
  syncIssueGuide,
  type SyncRunStatus,
  type SyncStatusResponse,
} from "@/ui/schemas/sync.schema";

/**
 * `syncIssueGuide` is the one place where an error code the screen has never
 * seen must still come out usable. Unknown codes are the edge case that matters:
 * the server can add one at any time, and a row that silently disappears breaks
 * business rule 5 ("không im lặng bỏ qua bất kỳ lỗi nào").
 */

describe("syncIssueGuide", () => {
  it("gives a concrete instruction for every code the usecase writes today", () => {
    for (const code of [
      "FILE_NAME_INVALID",
      "FILE_DUPLICATE",
      "FILE_NEEDS_REVIEW",
      "SHEET_ROW_INVALID",
      "SHEET_ERROR",
      "PRODUCT_NOT_FOUND",
      "MEDIA_NOT_FOUND",
      "SOURCE_EMPTY",
    ]) {
      const guide = syncIssueGuide(code);
      expect(guide.action.length).toBeGreaterThan(20);
      expect(guide.severity).toMatch(/neutral|warning|error/);
    }
  });

  /**
   * The three media codes used to be one. If they collapse back onto the same
   * severity the split buys the operator nothing.
   */
  it("ranks the three media codes apart", () => {
    expect(syncIssueGuide("FILE_NAME_INVALID").severity).toBe("error");
    expect(syncIssueGuide("FILE_DUPLICATE").severity).toBe("neutral");
    expect(syncIssueGuide("FILE_NEEDS_REVIEW").severity).toBe("warning");
  });

  it("says 'nothing to do' for a duplicate and 'rename it' for a bad name", () => {
    expect(syncIssueGuide("FILE_DUPLICATE").action).toContain("Không cần làm gì");
    expect(syncIssueGuide("FILE_NAME_INVALID").action).toContain("đổi tên");
    // The old wording covered duplicates too; that sentence must be gone.
    expect(syncIssueGuide("FILE_NAME_INVALID").action).not.toContain("trùng");
  });

  /**
   * SOURCE_EMPTY does not skip a file — it stops the whole run to avoid wiping
   * the catalog. Falling back would give it `warning` (its shape matches none
   * of the inferred patterns) and a sentence that answers neither question the
   * operator has: why it stopped, and what to do now.
   */
  it("treats a stopped sync as the heaviest severity and says what to do", () => {
    const guide = syncIssueGuide("SOURCE_EMPTY");
    expect(guide.severity).toBe("error");
    expect(guide.action).toContain("đã dừng");
    expect(guide.action).toContain("quyền đọc");
    expect(guide.action).not.toContain("chưa có hướng dẫn sẵn");
  });

  it("keeps a blocking code away from the informational tone", () => {
    expect(syncIssueGuide("SHEET_ROW_INVALID").severity).toBe("error");
    expect(syncIssueGuide("PRODUCT_NOT_FOUND").severity).toBe("error");
    expect(syncIssueGuide("MEDIA_NOT_FOUND").severity).toBe("warning");
  });

  it("still answers for an unknown code instead of throwing", () => {
    const guide = syncIssueGuide("SOMETHING_NEW_FROM_THE_SERVER");
    expect(guide.severity).toBe("warning");
    expect(guide.action.length).toBeGreaterThan(20);
  });

  it("infers the tone of an unknown code from its shape", () => {
    expect(syncIssueGuide("FILE_DUPLICATE").severity).toBe("neutral");
    expect(syncIssueGuide("SHEET_CODE_CONFLICT").severity).toBe("error");
    expect(syncIssueGuide("FILE_CODE_NOT_FOUND").severity).toBe("error");
    expect(syncIssueGuide("FILE_NEEDS_REVIEW").severity).toBe("warning");
  });

  it("does not care about the case of the code", () => {
    expect(syncIssueGuide("file_duplicate").severity).toBe("neutral");
  });

  it("answers for an empty code rather than crashing the table", () => {
    expect(syncIssueGuide("").severity).toBe("warning");
  });
});

describe("status wording", () => {
  it("says something different for every run status", () => {
    const labels = Object.values(SYNC_STATUS_LABELS);
    const hints = Object.values(SYNC_STATUS_HINTS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("does not let 'partial' read like a success", () => {
    expect(SYNC_STATUS_LABELS.partial).not.toBe(SYNC_STATUS_LABELS.succeeded);
    expect(SYNC_STATUS_HINTS.partial).toContain("bỏ qua");
  });
});

const STARTED_AT = "2026-08-13T01:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);
/** Ten seconds into the run — well inside the fast band. */
const NOW_MS = STARTED_AT_MS + 10_000;
/** End of the fast band: past this the run is old, but not yet declared dead. */
const FAST_BAND_MS = 330_000;
/** Past this the row is treated as abandoned (see `SYNC_RUN_HARD_MAX_AGE_MS`). */
const HARD_LIMIT_MS = 30 * 60_000;

function statusWithRun(status: SyncRunStatus, startedAt = STARTED_AT): SyncStatusResponse {
  return {
    state: "has_run",
    run: {
      tenantId: "00000000-0000-0000-0000-000000000001",
      syncRunId: "run-1",
      status,
      startedAt,
      finishedAt: status === "running" ? null : "2026-08-13T01:02:30.000Z",
      counts: null,
      issues: [],
      issueGroups: null,
      errorCode: null,
      errorMessage: null,
      recentRuns: [],
    },
  };
}

/**
 * The "Chạy đồng bộ" button AND the "vẫn đang chạy" banner both read this, so
 * its edges are shared, and both failure modes are expensive:
 *  - believing a dead run keeps the button disabled forever after a crash;
 *  - declaring a live run dead re-opens the button ON TOP of a sync that is
 *    still writing rows.
 * Hence the wide bound: on a self-hosted deploy nothing stops the handler at
 * the route's `maxDuration`, so a 5.500-file catalogue may legitimately run for
 * many minutes.
 */
describe("isSyncRunLive", () => {
  it("says no when there is no run at all", () => {
    expect(isSyncRunLive(null, NOW_MS)).toBe(false);
    expect(isSyncRunLive(undefined, NOW_MS)).toBe(false);
  });

  it("says yes only for a running row", () => {
    expect(isSyncRunLive({ status: "running", startedAt: STARTED_AT }, NOW_MS)).toBe(true);
    expect(isSyncRunLive({ status: "succeeded", startedAt: STARTED_AT }, NOW_MS)).toBe(false);
    expect(isSyncRunLive({ status: "failed", startedAt: STARTED_AT }, NOW_MS)).toBe(false);
  });

  it("still believes a long sync well past the proxy timeout", () => {
    // The whole point of the wide bound: 300s is when Caddy drops the
    // CONNECTION, not when the handler stops walking Drive.
    const run = { status: "running" as const, startedAt: STARTED_AT };
    expect(isSyncRunLive(run, STARTED_AT_MS + FAST_BAND_MS + 60_000)).toBe(true);
    expect(isSyncRunLive(run, STARTED_AT_MS + 20 * 60_000)).toBe(true);
  });

  it("gives up on a row nobody is ever going to move again", () => {
    const run = { status: "running" as const, startedAt: STARTED_AT };
    expect(isSyncRunLive(run, STARTED_AT_MS + HARD_LIMIT_MS - 1_000)).toBe(true);
    expect(isSyncRunLive(run, STARTED_AT_MS + HARD_LIMIT_MS + 1_000)).toBe(false);
    expect(isSyncRunLive(run, STARTED_AT_MS + 86_400_000)).toBe(false);
  });

  it("does not call a run dead because this browser's clock runs fast", () => {
    // Client ahead of the server: `startedAt` lands in the future, the age goes
    // negative. Skew must not read as "this run died" the instant it started.
    const run = { status: "running" as const, startedAt: STARTED_AT };
    expect(isSyncRunLive(run, STARTED_AT_MS - 60_000)).toBe(true);
    expect(isSyncRunLive(run, STARTED_AT_MS - 86_400_000)).toBe(true);
  });

  it("does not believe a timestamp it cannot read", () => {
    expect(isSyncRunLive({ status: "running", startedAt: "hôm qua" }, NOW_MS)).toBe(false);
  });
});

describe("syncStatusPollInterval", () => {
  it("does not poll before the first answer arrives", () => {
    expect(syncStatusPollInterval(undefined, 0, NOW_MS)).toBe(false);
  });

  it("does not poll a tenant that has never synced", () => {
    expect(
      syncStatusPollInterval(
        { state: "never_synced", tenantId: "00000000-0000-0000-0000-000000000001" },
        0,
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("stops polling for every terminal run status", () => {
    for (const status of ["succeeded", "partial", "failed"] as const) {
      expect(syncStatusPollInterval(statusWithRun(status), 4, NOW_MS)).toBe(false);
    }
  });

  it("polls a running sync, backing off to a ceiling", () => {
    expect(syncStatusPollInterval(statusWithRun("running"), 0, NOW_MS)).toBe(3_000);
    expect(syncStatusPollInterval(statusWithRun("running"), 5, NOW_MS)).toBe(8_000);
    expect(syncStatusPollInterval(statusWithRun("running"), 99, NOW_MS)).toBe(15_000);
  });

  /**
   * Three bands, because the two hazards point in opposite directions: a
   * self-hosted sync can genuinely outlive the proxy timeout (so "old" must not
   * mean "stop"), while a crashed row says `running` forever (so "old" must not
   * mean "poll at 15s until the tab closes" — the "job `running` vĩnh viễn"
   * anti-pattern of core-long-running-jobs).
   */
  it("drops to a slow beat once the run outlives the fast band", () => {
    const old = statusWithRun("running");
    expect(syncStatusPollInterval(old, 0, STARTED_AT_MS + FAST_BAND_MS - 1_000)).toBe(3_000);
    expect(syncStatusPollInterval(old, 0, STARTED_AT_MS + FAST_BAND_MS + 1_000)).toBe(60_000);
    // The backoff no longer applies in this band — it is a flat beat.
    expect(syncStatusPollInterval(old, 99, STARTED_AT_MS + 20 * 60_000)).toBe(60_000);
  });

  it("gives up on a row nobody is ever going to move again", () => {
    const stuck = statusWithRun("running");
    expect(syncStatusPollInterval(stuck, 0, STARTED_AT_MS + HARD_LIMIT_MS - 1_000)).toBe(60_000);
    expect(syncStatusPollInterval(stuck, 0, STARTED_AT_MS + HARD_LIMIT_MS + 1_000)).toBe(false);
    expect(syncStatusPollInterval(stuck, 0, STARTED_AT_MS + 86_400_000)).toBe(false);
  });

  it("keeps polling through clock skew in either direction", () => {
    // Client behind the server, then far ahead of it. Neither may stop a run
    // that has only just started.
    expect(syncStatusPollInterval(statusWithRun("running"), 0, STARTED_AT_MS - 60_000)).toBe(3_000);
    expect(syncStatusPollInterval(statusWithRun("running"), 0, STARTED_AT_MS - 86_400_000)).toBe(
      3_000,
    );
  });

  it("never answers with a negative interval, whatever the tick count says", () => {
    expect(syncStatusPollInterval(statusWithRun("running"), -16, NOW_MS)).toBe(3_000);
  });

  it("stops rather than polls forever when startedAt cannot be read", () => {
    const unparsable = statusWithRun("running", "hôm qua");
    expect(syncStatusPollInterval(unparsable, 0, NOW_MS)).toBe(false);
  });
});

describe("nextSyncStatusPoll", () => {
  const running = statusWithRun("running");

  it("slows down on a failing query instead of giving up on it", () => {
    // `false` here would freeze the panel until a manual reload: the operator
    // is watching this screen, so the focus-refetch that would have rescued it
    // never fires.
    expect(
      nextSyncStatusPoll({
        isError: true,
        data: running,
        updateCount: 40,
        base: 37,
        nowMs: NOW_MS,
      }),
    ).toEqual({ interval: 30_000, base: null });
  });

  /**
   * The regression this shape exists for: `base` lives in a hook ref while
   * `dataUpdateCount` lives on the Query object, and swapping companies swaps
   * the Query without remounting the hook. The stale anchor produced a negative
   * elapsed, which reached TanStack as a negative interval — silently never
   * scheduled (`isValidTimeout` wants >= 0), so polling just stopped.
   */
  it("never produces a negative interval when the anchor outlives its query", () => {
    const stale = nextSyncStatusPoll({
      isError: false,
      data: running,
      updateCount: 2,
      base: 18,
      nowMs: NOW_MS,
    });
    expect(stale.interval === false || stale.interval >= 0).toBe(true);
    expect(stale.interval).toBe(3_000);
  });

  it("starts a new session at the fast end however old the query is", () => {
    expect(
      nextSyncStatusPoll({
        isError: false,
        data: running,
        updateCount: 400,
        base: null,
        nowMs: NOW_MS,
      }),
    ).toEqual({ interval: 3_000, base: 400 });
  });

  it("backs off by the ticks of THIS session, not of the whole query", () => {
    expect(
      nextSyncStatusPoll({
        isError: false,
        data: running,
        updateCount: 405,
        base: 400,
        nowMs: NOW_MS,
      }),
    ).toEqual({ interval: 8_000, base: 400 });
  });

  it("drops the anchor when the run settles, so the next run starts fast", () => {
    expect(
      nextSyncStatusPoll({
        isError: false,
        data: statusWithRun("succeeded"),
        updateCount: 405,
        base: 400,
        nowMs: NOW_MS,
      }),
    ).toEqual({ interval: false, base: null });
  });

  it("holds the anchor while the run is merely old, and drops it once stuck", () => {
    // Old (past the fast band): still watched, flat beat, session continues.
    expect(
      nextSyncStatusPoll({
        isError: false,
        data: running,
        updateCount: 405,
        base: 400,
        nowMs: STARTED_AT_MS + FAST_BAND_MS + 60_000,
      }),
    ).toEqual({ interval: 60_000, base: 400 });

    // Stuck: nothing left to watch, so the next run starts its curve fresh.
    expect(
      nextSyncStatusPoll({
        isError: false,
        data: running,
        updateCount: 405,
        base: 400,
        nowMs: STARTED_AT_MS + HARD_LIMIT_MS + 1_000,
      }),
    ).toEqual({ interval: false, base: null });
  });
});

describe("isSyncStillRunningError", () => {
  const apiError = (code: string, status: number) =>
    new ApiError({ code, status, userMessage: "x" });

  it("recognises the client timeout — the sync is still writing rows server-side", () => {
    expect(isSyncStillRunningError(apiError(CLIENT_ERROR_CODES.TIMEOUT, 0))).toBe(true);
  });

  it("does not excuse a real server failure or a 4xx", () => {
    expect(isSyncStillRunningError(apiError("SHEET_ERROR", 500))).toBe(false);
    expect(isSyncStillRunningError(apiError("TENANT_NOT_SELECTED", 409))).toBe(false);
  });

  it("does not excuse an offline request, which never reached the server", () => {
    expect(isSyncStillRunningError(apiError(CLIENT_ERROR_CODES.NETWORK, 0))).toBe(false);
  });

  it("survives a throwable that is not an ApiError at all", () => {
    expect(isSyncStillRunningError(new Error("boom"))).toBe(false);
    expect(isSyncStillRunningError(undefined)).toBe(false);
  });
});

describe("SyncRunSchema — history runs written before this release", () => {
  const base = {
    tenantId: "00000000-0000-0000-0000-000000000001",
    syncRunId: "run-1",
    status: "partial" as const,
    startedAt: "2026-08-13T01:00:00.000Z",
    finishedAt: "2026-08-13T01:02:30.000Z",
    counts: null,
    issues: [],
    issueGroups: null,
    errorCode: null,
    errorMessage: null,
    recentRuns: [],
  };

  it("accepts a null issueGroups instead of rejecting the whole run", () => {
    const parsed = SyncRunSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.issueGroups).toBeNull();
  });

  it("accepts a history row with no finish and no issue total", () => {
    const parsed = SyncRunSchema.safeParse({
      ...base,
      recentRuns: [
        {
          syncRunId: "run-0",
          status: "running",
          startedAt: "2026-08-13T01:00:00.000Z",
          finishedAt: null,
          issuesTotal: null,
          errorCode: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a run object that lost recentRuns entirely — that is server drift", () => {
    const { recentRuns: _dropped, ...withoutHistory } = base;
    expect(SyncRunSchema.safeParse(withoutHistory).success).toBe(false);
  });
});
