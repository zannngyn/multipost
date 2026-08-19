import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  SyncRunCounts,
  SyncRunListItem,
  SyncRunRepo,
  SyncRunSummary,
} from "@/core/ports/product-repo";

import { DEFAULT_RECENT_RUNS, makeGetSyncStatus, MAX_RECENT_RUNS } from "./get-sync-status";

const TENANT = "00000000-0000-0000-0000-000000000001";

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

const counts: SyncRunCounts = {
  driveFilesSeen: 5497,
  mediaParsed: 3900,
  mediaRejected: 1500,
  mediaDuplicatesDropped: 97,
  mediaNeedingReview: 800,
  sheetRowsSeen: 1200,
  productsParsed: 1190,
  sheetRowsRejected: 10,
  productsWithConflict: 2,
  productsWithoutMedia: 40,
  mediaWithoutProduct: 12,
  productsWritten: 1190,
  mediaWritten: 3900,
  productsDeleted: 0,
  mediaDeleted: 0,
  issuesTotal: 1659,
  issuesTruncated: true,
};

const issue = {
  errorCode: "FILE_NAME_INVALID",
  reason: "NO_PRODUCT_CODE",
  ref: "IMG_1664.JPG",
  detail: "Tên file không chứa mã sản phẩm nào — đổi tên theo mẫu MÃSP-Màu (số).",
};

const summary: SyncRunSummary = {
  id: "run-1",
  status: "partial",
  startedAt: new Date("2026-08-13T01:00:00.000Z"),
  finishedAt: new Date("2026-08-13T01:02:30.000Z"),
  counts,
  issues: [issue],
  issueGroups: [{ errorCode: "FILE_NAME_INVALID", count: 1500, examples: [issue] }],
  errorCode: null,
  errorMessage: null,
};

/** The history the repo would return for `summary` plus one older run. */
const recent: SyncRunListItem[] = [
  {
    id: "run-1",
    status: "partial",
    startedAt: new Date("2026-08-13T01:00:00.000Z"),
    finishedAt: new Date("2026-08-13T01:02:30.000Z"),
    issuesTotal: 1659,
    errorCode: null,
  },
  {
    id: "run-0",
    status: "failed",
    startedAt: new Date("2026-08-12T01:00:00.000Z"),
    finishedAt: null,
    issuesTotal: null,
    errorCode: "DRIVE_ERROR",
  },
];

function makeHarness(
  latest: SyncRunSummary | null,
  error?: unknown,
  recentRuns: SyncRunListItem[] = recent,
) {
  const logger = makeLogger();
  const syncRuns: SyncRunRepo = {
    start: async () => ({ id: "run-1" }),
    finish: async () => {},
    findLatest: vi.fn(async () => {
      if (error) throw error;
      return latest;
    }),
    listRecent: vi.fn(async (_tenantId: string, limit: number) => recentRuns.slice(0, limit)),
  };
  return { run: makeGetSyncStatus({ syncRuns, logger }), syncRuns, logger };
}

describe("getSyncStatus — edge cases first", () => {
  it.each([["", "empty"], ["   ", "blank"], ["not-a-uuid", "malformed"]])(
    "rejects tenant id %s (%s) before touching the repo",
    async (tenantId) => {
      const harness = makeHarness(summary);
      await expect(harness.run({ tenantId })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(harness.syncRuns.findLatest).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const harness = makeHarness(summary);
    await expect(
      harness.run(undefined as unknown as { tenantId: string }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.syncRuns.findLatest).not.toHaveBeenCalled();
  });

  it.each([
    [0, "zero"],
    [-1, "negative"],
    [MAX_RECENT_RUNS + 1, "above the cap"],
    [2.5, "not an integer"],
    [Number.NaN, "NaN"],
    ["5" as unknown as number, "a string"],
  ])("rejects recentLimit %s (%s) instead of clamping it", async (recentLimit) => {
    const harness = makeHarness(summary);

    await expect(harness.run({ tenantId: TENANT, recentLimit })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.syncRuns.findLatest).not.toHaveBeenCalled();
    expect(harness.syncRuns.listRecent).not.toHaveBeenCalled();
  });

  it("accepts both ends of the allowed range", async () => {
    for (const recentLimit of [1, MAX_RECENT_RUNS]) {
      const harness = makeHarness(summary);
      await expect(harness.run({ tenantId: TENANT, recentLimit })).resolves.not.toBeNull();
      expect(harness.syncRuns.listRecent).toHaveBeenCalledWith(TENANT, recentLimit);
    }
  });

  it("returns null when the tenant has never synced, without asking for history", async () => {
    const harness = makeHarness(null);
    await expect(harness.run({ tenantId: TENANT })).resolves.toBeNull();
    expect(harness.syncRuns.listRecent).not.toHaveBeenCalled();
  });

  it("carries a null issueGroups through, so old runs are not shown as zero", async () => {
    // A run stored before the column existed. `issues` is all the screen has.
    const harness = makeHarness({ ...summary, issueGroups: null });

    const result = await harness.run({ tenantId: TENANT });
    expect(result?.issueGroups).toBeNull();
    expect(result?.issues).toHaveLength(1);
  });

  it("keeps a still-running history row distinguishable: no finish, no total", async () => {
    const harness = makeHarness(summary, undefined, [
      {
        id: "run-2",
        status: "running",
        startedAt: new Date("2026-08-13T02:00:00.000Z"),
        finishedAt: null,
        issuesTotal: null,
        errorCode: null,
      },
    ]);

    const result = await harness.run({ tenantId: TENANT });
    expect(result?.recentRuns).toEqual([
      {
        syncRunId: "run-2",
        status: "running",
        startedAt: "2026-08-13T02:00:00.000Z",
        finishedAt: null,
        issuesTotal: null,
        errorCode: null,
      },
    ]);
  });

  it("returns an empty history rather than failing when the repo has none", async () => {
    const harness = makeHarness(summary, undefined, []);
    const result = await harness.run({ tenantId: TENANT });
    expect(result?.recentRuns).toEqual([]);
  });

  it("propagates a repo DB_ERROR untouched", async () => {
    const harness = makeHarness(null, new AppError("DB_ERROR", { message: "connection refused" }));
    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("reports a run that is still running: no finishedAt, no counts", async () => {
    const harness = makeHarness({
      ...summary,
      status: "running",
      finishedAt: null,
      counts: null,
      issues: [],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result).toMatchObject({ status: "running", finishedAt: null, counts: null });
    expect(result?.issues).toEqual([]);
  });

  it("carries the failure reason of a failed run", async () => {
    const harness = makeHarness({
      ...summary,
      status: "failed",
      errorCode: "DRIVE_ERROR",
      errorMessage: "permission denied",
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "DRIVE_ERROR",
      errorMessage: "permission denied",
    });
  });
});

describe("getSyncStatus — happy path", () => {
  it("returns the latest run with ISO dates and the uncapped issue counters", async () => {
    const harness = makeHarness(summary);

    const result = await harness.run({ tenantId: `  ${TENANT}  ` });

    expect(result).toEqual({
      tenantId: TENANT,
      syncRunId: "run-1",
      status: "partial",
      startedAt: "2026-08-13T01:00:00.000Z",
      finishedAt: "2026-08-13T01:02:30.000Z",
      counts,
      issues: summary.issues,
      issueGroups: summary.issueGroups,
      errorCode: null,
      errorMessage: null,
      recentRuns: [
        {
          syncRunId: "run-1",
          status: "partial",
          startedAt: "2026-08-13T01:00:00.000Z",
          finishedAt: "2026-08-13T01:02:30.000Z",
          issuesTotal: 1659,
          errorCode: null,
        },
        {
          syncRunId: "run-0",
          status: "failed",
          startedAt: "2026-08-12T01:00:00.000Z",
          finishedAt: null,
          issuesTotal: null,
          errorCode: "DRIVE_ERROR",
        },
      ],
    });
    expect(result?.counts?.issuesTotal).toBe(1659);
    expect(result?.counts?.issuesTruncated).toBe(true);
    // The exact group count survives the cap on `issues[]`: 1 stored, 1500 real.
    expect(result?.issueGroups?.[0]).toMatchObject({ count: 1500 });
    expect(harness.syncRuns.findLatest).toHaveBeenCalledWith(TENANT);
    // Six by default: the rail drops the run it already describes in full, so
    // asking for five would leave only four rows under "5 lần chạy trước".
    expect(DEFAULT_RECENT_RUNS).toBe(6);
    expect(harness.syncRuns.listRecent).toHaveBeenCalledWith(TENANT, DEFAULT_RECENT_RUNS);
  });
});
