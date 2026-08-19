import { describe, expect, it } from "vitest";

import {
  progressBarView,
  progressTimingView,
  stepStates,
} from "@/ui/components/batch/channel-progress";
import type { BatchChannelProgress } from "@/ui/schemas/post-batch.schema";

/**
 * The two claims this screen makes that would be lies if they regressed
 * (design §3.2): what the bar says was counted, and what the timing line says
 * is known. Edge cases first (CLAUDE.md technical rule 1).
 */

const STARTED = "2026-08-12T03:00:00.000Z";
const STARTED_MS = Date.parse(STARTED);

function makeProgress(overrides: Partial<BatchChannelProgress> = {}): BatchChannelProgress {
  return {
    stage: "uploading_media",
    stepIndex: 2,
    label: "Đang tải ảnh lên kênh 3/10 (IMG_2041.jpg)",
    doneCount: 3,
    totalCount: 10,
    currentItem: "IMG_2041.jpg",
    stageStartedAt: STARTED,
    waitUntil: null,
    ...overrides,
  };
}

describe("progressBarView — edge cases first", () => {
  it("stays indeterminate when nothing was counted", () => {
    const view = progressBarView(makeProgress({ doneCount: null, totalCount: null }));
    expect(view.kind).toBe("indeterminate");
  });

  it("stays indeterminate when only one half of the pair arrived", () => {
    expect(progressBarView(makeProgress({ doneCount: 3, totalCount: null })).kind).toBe(
      "indeterminate",
    );
    expect(progressBarView(makeProgress({ doneCount: null, totalCount: 10 })).kind).toBe(
      "indeterminate",
    );
  });

  it("stays indeterminate on a zero total instead of dividing by it", () => {
    expect(progressBarView(makeProgress({ doneCount: 0, totalCount: 0 })).kind).toBe(
      "indeterminate",
    );
  });

  it("falls back to a spoken label when the server sent none", () => {
    const view = progressBarView(makeProgress({ doneCount: null, totalCount: null, label: "" }));
    expect(view.valueText).toBe("Đang xử lý");
  });

  it("clamps a count that overshoots its total rather than showing 130%", () => {
    const view = progressBarView(makeProgress({ doneCount: 13, totalCount: 10 }));
    expect(view).toMatchObject({ kind: "determinate", valueNow: 10, percent: 100 });
  });

  it("clamps a negative count to zero", () => {
    const view = progressBarView(makeProgress({ doneCount: -4, totalCount: 10 }));
    expect(view).toMatchObject({ kind: "determinate", valueNow: 0, percent: 0 });
  });

  it("reports a real upload with its count, percentage and file name", () => {
    const view = progressBarView(makeProgress());
    expect(view).toMatchObject({
      kind: "determinate",
      valueNow: 3,
      valueMax: 10,
      percent: 30,
    });
    expect(view.valueText).toBe("Đã tải 3/10 ảnh (30%) — IMG_2041.jpg");
  });

  it("omits the file name when the server sent none", () => {
    const view = progressBarView(makeProgress({ currentItem: null }));
    expect(view.valueText).toBe("Đã tải 3/10 ảnh (30%)");
  });
});

describe("progressTimingView — edge cases first", () => {
  it("says nothing before the browser clock has ticked (hydration)", () => {
    expect(progressTimingView(makeProgress(), 0)).toBeNull();
  });

  it("says nothing when the start time is unparsable", () => {
    expect(progressTimingView(makeProgress({ stageStartedAt: "hôm qua" }), STARTED_MS)).toBeNull();
  });

  it("says nothing rather than 'đã chạy -3 giây' when the clocks disagree", () => {
    expect(progressTimingView(makeProgress(), STARTED_MS - 3_000)).toBeNull();
  });

  it("counts elapsed time when there is no deadline — never an estimate", () => {
    const view = progressTimingView(makeProgress(), STARTED_MS + 42_000);
    expect(view).toEqual({ kind: "elapsed", text: "Đã chạy 42 giây" });
  });

  it("counts DOWN only against a deadline the system computed", () => {
    const waitUntil = new Date(STARTED_MS + 60_000).toISOString();
    const view = progressTimingView(
      makeProgress({ stage: "waiting_for_spacing", waitUntil }),
      STARTED_MS + 15_000,
    );
    expect(view).toEqual({ kind: "countdown", text: "Còn 45 giây" });
  });

  it("switches to 'đã tới hạn' instead of counting into negative time", () => {
    const waitUntil = new Date(STARTED_MS + 10_000).toISOString();
    const view = progressTimingView(
      makeProgress({ stage: "waiting_for_spacing", waitUntil }),
      STARTED_MS + 30_000,
    );
    expect(view).toEqual({ kind: "due", text: "Đã tới hạn — đang chờ hệ thống xử lý" });
  });

  it("ignores a waitUntil that is not a real date and falls back to elapsed", () => {
    const view = progressTimingView(makeProgress({ waitUntil: "sắp tới" }), STARTED_MS + 5_000);
    expect(view).toEqual({ kind: "elapsed", text: "Đã chạy 5 giây" });
  });
});

describe("stepStates — edge cases first", () => {
  it("returns nothing for an empty stepper", () => {
    expect(stepStates(0, 1)).toEqual([]);
  });

  it("marks nothing current when the index is off the list", () => {
    // An older screen against a newer server: leaving every step "upcoming"
    // beats lighting up the wrong one.
    expect(stepStates(3, 9)).toEqual(["done", "done", "done"]);
    expect(stepStates(3, -1)).toEqual(["upcoming", "upcoming", "upcoming"]);
  });

  it("splits the list into done, current and upcoming", () => {
    expect(stepStates(4, 1)).toEqual(["done", "current", "upcoming", "upcoming"]);
  });

  it("marks the whole list done on the last step", () => {
    expect(stepStates(3, 2)).toEqual(["done", "done", "current"]);
  });
});
