import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { SyncRunCounts, SyncRunRepo, SyncRunSummary } from "@/core/ports/product-repo";

import { makeGetSyncStatus } from "./get-sync-status";

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

const summary: SyncRunSummary = {
  id: "run-1",
  status: "partial",
  startedAt: new Date("2026-08-13T01:00:00.000Z"),
  finishedAt: new Date("2026-08-13T01:02:30.000Z"),
  counts,
  issues: [
    { errorCode: "FILE_NAME_INVALID", reason: "NO_PRODUCT_CODE", ref: "IMG_1664.JPG", detail: "x" },
  ],
  errorCode: null,
  errorMessage: null,
};

function makeHarness(latest: SyncRunSummary | null, error?: unknown) {
  const logger = makeLogger();
  const syncRuns: SyncRunRepo = {
    start: async () => ({ id: "run-1" }),
    finish: async () => {},
    findLatest: vi.fn(async () => {
      if (error) throw error;
      return latest;
    }),
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

  it("returns null when the tenant has never synced", async () => {
    const harness = makeHarness(null);
    await expect(harness.run({ tenantId: TENANT })).resolves.toBeNull();
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
      errorCode: null,
      errorMessage: null,
    });
    expect(result?.counts?.issuesTotal).toBe(1659);
    expect(result?.counts?.issuesTruncated).toBe(true);
    expect(harness.syncRuns.findLatest).toHaveBeenCalledWith(TENANT);
  });
});
