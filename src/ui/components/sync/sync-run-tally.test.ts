import { describe, expect, it } from "vitest";

import { NO_TALLY, runTally } from "@/ui/components/sync/sync-run-tally";
import type { RecentSyncRun } from "@/ui/schemas/sync.schema";

function makeRun(overrides: Partial<RecentSyncRun> = {}): RecentSyncRun {
  return {
    syncRunId: "run-1",
    status: "succeeded",
    startedAt: "2026-08-22T03:00:00.000Z",
    finishedAt: "2026-08-22T03:04:12.000Z",
    issuesTotal: 0,
    errorCode: null,
    ...overrides,
  };
}

describe("runTally — no number available", () => {
  it("says a running run has not finished, in words and not just a label", () => {
    const tally = runTally(makeRun({ status: "running", finishedAt: null, issuesTotal: null }));

    expect(tally.value).toBe(NO_TALLY);
    expect(tally.label).toBe("chưa xong");
    expect(tally.isQuiet).toBe(true);
    expect(tally.note).toBe("Chưa kết thúc — chưa có số liệu.");
  });

  it("treats a crashed run with no finishedAt as unfinished, whatever its status", () => {
    // A run that died mid-way is `failed` AND has no end. Reading the status
    // column alone would print "0 vấn đề" for it.
    const tally = runTally(
      makeRun({ status: "failed", finishedAt: null, issuesTotal: 0, errorCode: "DRIVE_TIMEOUT" }),
    );

    expect(tally.value).toBe(NO_TALLY);
    expect(tally.label).toBe("chưa xong");
    expect(tally.note).toBe("Chưa kết thúc — chưa có số liệu.");
  });

  it("distinguishes 'the count was never recorded' from 'not finished'", () => {
    const tally = runTally(makeRun({ status: "partial", issuesTotal: null }));

    expect(tally.value).toBe(NO_TALLY);
    expect(tally.label).toBe("không rõ");
    expect(tally.isQuiet).toBe(true);
    // The whole point of M-3: these two placeholders must not read alike.
    expect(tally.note).toBe("Không ghi được số vấn đề của lần chạy này.");
    expect(tally.note).not.toBe(
      runTally(makeRun({ status: "running", finishedAt: null, issuesTotal: null })).note,
    );
  });
});

describe("runTally — a real number", () => {
  it("keeps a clean run quiet but still says zero", () => {
    const tally = runTally(makeRun({ issuesTotal: 0 }));

    expect(tally.value).toBe("0");
    expect(tally.label).toBe("vấn đề");
    expect(tally.isQuiet).toBe(true);
    expect(tally.note).toBeNull();
  });

  it("prints a large count grouped, and does not dim it", () => {
    const tally = runTally(makeRun({ status: "partial", issuesTotal: 7433 }));

    expect(tally.value).toBe("7.433");
    expect(tally.label).toBe("vấn đề");
    expect(tally.isQuiet).toBe(false);
    expect(tally.note).toBeNull();
  });

  it("keeps a single issue at reading size too", () => {
    expect(runTally(makeRun({ issuesTotal: 1 }))).toMatchObject({
      value: "1",
      isQuiet: false,
      note: null,
    });
  });

  it("does not invent a number from a non-finite count", () => {
    // Comes through the schema as a number; `formatCount` is the guard.
    const tally = runTally(makeRun({ issuesTotal: Number.POSITIVE_INFINITY }));

    expect(tally.value).toBe(NO_TALLY);
  });
});
