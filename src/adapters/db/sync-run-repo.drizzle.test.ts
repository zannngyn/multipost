import { describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { DrizzleSyncRunRepo } from "./sync-run-repo.drizzle";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * `listRecent` without a database: the query builder is stubbed, the ROW
 * VALIDATION is real — that is the part this test is about.
 *
 * Edge cases first: the history rail is a secondary list, so one unreadable row
 * must degrade to "unknown" instead of taking the whole sync-status response
 * (funnel + issue table of the CURRENT run) down with it.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

/** Stand-in for `select(...).from().where().orderBy().limit()`. */
function stubDb(rows: unknown[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
      }),
    }),
  } as unknown as Database;
}

const goodCounts = {
  driveFilesSeen: 10,
  mediaParsed: 8,
  mediaRejected: 2,
  mediaDuplicatesDropped: 0,
  mediaNeedingReview: 1,
  sheetRowsSeen: 3,
  productsParsed: 3,
  sheetRowsRejected: 0,
  productsWithConflict: 0,
  productsWithoutMedia: 0,
  mediaWithoutProduct: 0,
  productsWritten: 3,
  mediaWritten: 8,
  productsDeleted: 0,
  mediaDeleted: 0,
  issuesTotal: 42,
  issuesTruncated: false,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "succeeded",
    startedAt: new Date("2026-08-13T03:00:00.000Z"),
    finishedAt: new Date("2026-08-13T03:01:00.000Z"),
    counts: goodCounts,
    errorCode: null,
    ...overrides,
  };
}

function harness(rows: unknown[]) {
  const lines: LogLine[] = [];
  const repo = new DrizzleSyncRunRepo(stubDb(rows), recordingLogger(lines));
  return { repo, lines };
}

describe("listRecent — edge cases first", () => {
  it.each([
    [0, "zero"],
    [-2, "negative"],
    [1.5, "fractional"],
    [Number.NaN, "NaN"],
  ])("refuses limit %s (%s) before building any SQL", async (limit) => {
    const { repo } = harness([row()]);

    await expect(repo.listRecent(TENANT, limit)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { operation: "syncRun.listRecent" },
    });
  });

  it("refuses a malformed tenant id", async () => {
    const { repo } = harness([row()]);
    await expect(repo.listRecent(testTenantId("not-a-uuid"), 5)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("returns an empty list for a tenant with no runs", async () => {
    const { repo } = harness([]);
    await expect(repo.listRecent(TENANT, 5)).resolves.toEqual([]);
  });

  it("reports a still-running row as unfinished with no issue total", async () => {
    const { repo, lines } = harness([row({ status: "running", finishedAt: null, counts: null })]);

    const rows = await repo.listRecent(TENANT, 5);
    expect(rows[0]).toMatchObject({ status: "running", finishedAt: null, issuesTotal: null });
    // A run that simply has not finished is normal — it must not log a warning.
    expect(lines).toHaveLength(0);
  });

  /** The reason this method does not reuse `findLatest`'s strictness. */
  it("degrades ONE unreadable row and still returns the others", async () => {
    const { repo } = harness([
      row({ id: "aaaaaaaa-0000-0000-0000-000000000001" }),
      row({
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        // Written by an older shape: `issuesTotal` is gone.
        counts: { driveFilesSeen: 1, mediaParsed: 1 },
      }),
      row({ id: "cccccccc-0000-0000-0000-000000000003" }),
    ]);

    const rows = await repo.listRecent(TENANT, 5);

    expect(rows).toHaveLength(3);
    expect(rows.map((item) => item.issuesTotal)).toEqual([42, null, 42]);
    // The broken row keeps everything that IS readable about it.
    expect(rows[1]).toMatchObject({
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      status: "succeeded",
    });
  });

  it("never degrades silently: the skipped row is logged with its ids", async () => {
    const { repo, lines } = harness([row({ counts: { nope: true } })]);

    await repo.listRecent(TENANT, 5);

    const warning = lines.find((line) => line.level === "warn");
    expect(warning).toBeDefined();
    expect(warning?.context).toMatchObject({
      error_code: "DB_ERROR",
      tenant_id: TENANT,
      sync_run_id: "11111111-1111-1111-1111-111111111111",
      operation: "syncRun.listRecent",
    });
    expect(warning?.context?.err).toBeDefined();
  });

  it("still refuses a row whose STATUS is unknown — that is not degradable", async () => {
    const { repo } = harness([row({ status: "half-done" })]);

    await expect(repo.listRecent(TENANT, 5)).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("still refuses a row with no usable startedAt", async () => {
    const { repo } = harness([row({ startedAt: "yesterday" })]);

    await expect(repo.listRecent(TENANT, 5)).rejects.toMatchObject({ code: "DB_ERROR" });
  });
});

describe("listRecent — happy path", () => {
  it("maps every column the rail paints, and nothing else", async () => {
    const { repo, lines } = harness([
      row({ status: "failed", errorCode: "DRIVE_ERROR", counts: null, finishedAt: null }),
    ]);

    const rows = await repo.listRecent(TENANT, 6);

    expect(rows).toEqual([
      {
        id: "11111111-1111-1111-1111-111111111111",
        status: "failed",
        startedAt: new Date("2026-08-13T03:00:00.000Z"),
        finishedAt: null,
        issuesTotal: null,
        errorCode: "DRIVE_ERROR",
      },
    ]);
    // No `issues` / `issueGroups`: the history list must stay small.
    expect(Object.keys(rows[0])).toEqual([
      "id",
      "status",
      "startedAt",
      "finishedAt",
      "issuesTotal",
      "errorCode",
    ]);
    expect(lines).toHaveLength(0);
  });

  it("works without a logger at all (it is optional on the constructor)", async () => {
    const repo = new DrizzleSyncRunRepo(stubDb([row({ counts: { nope: true } })]));

    await expect(repo.listRecent(TENANT, 5)).resolves.toMatchObject([{ issuesTotal: null }]);
  });
});
