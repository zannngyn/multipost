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

  it("says a crashed run STOPPED, never that it is still going (B-2)", () => {
    // A run that died mid-way is `failed` AND has no end. It must not print
    // "0 vấn đề" — and it must not print "chưa xong" either, two lines under a
    // status reading "Thất bại" and a line reading "Dừng vì DRIVE_TIMEOUT".
    const tally = runTally(
      makeRun({ status: "failed", finishedAt: null, issuesTotal: 0, errorCode: "DRIVE_TIMEOUT" }),
    );

    expect(tally.value).toBe(NO_TALLY);
    expect(tally.isQuiet).toBe(true);
    // Pinned like the `partial` branch below, not asserted by inequality: a
    // "not chưa xong" passes on any third word, including a worse one.
    expect(tally.label).toBe("không rõ");
    expect(tally.note).toBe("Dừng giữa chừng — không có số liệu.");
    expect(tally.note).not.toBe(
      runTally(makeRun({ status: "running", finishedAt: null, issuesTotal: null })).note,
    );
  });

  it("does not call a finished run unfinished just because the end time is missing", () => {
    // `succeeded`/`partial` with no `finishedAt` is a recording fault, not a
    // crash — so it gets neither the running sentence nor the crashed one.
    const tally = runTally(makeRun({ status: "partial", finishedAt: null, issuesTotal: 12 }));

    expect(tally.value).toBe(NO_TALLY);
    expect(tally.label).toBe("không rõ");
    expect(tally.note).toBe("Không ghi được lúc kết thúc — không có số liệu.");
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

  it("does not invent a number from a non-finite count, and says so out loud (B-1)", () => {
    // Comes through the schema typed as a number. The dash it prints is
    // `aria-hidden` (there is no number behind it), so without a note the row
    // read "vấn đề" to a screen reader — indistinguishable from a clean run.
    for (const broken of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const tally = runTally(makeRun({ issuesTotal: broken }));

      expect(tally.value).toBe(NO_TALLY);
      expect(tally.label).toBe("không rõ");
      expect(tally.isQuiet).toBe(true);
      expect(tally.note).toBe("Không đọc được số vấn đề của lần chạy này.");
    }
  });

  it("keeps 'không đọc được' apart from 'không ghi được'", () => {
    // Two different faults: one count was recorded and is unreadable, the other
    // was never recorded at all. Same label, and that is why the note exists.
    expect(runTally(makeRun({ issuesTotal: Number.NaN })).note).not.toBe(
      runTally(makeRun({ issuesTotal: null })).note,
    );
  });
});
