import { describe, expect, it } from "vitest";

import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";

import { buildStepViews } from "./setup-steps";

/**
 * Every rule about what is locked, what comes next and what the operator is
 * told lives in `buildStepViews`. Testing it here means the dock and the full
 * checklist cannot drift apart: they read the same answer.
 */

const REQUIRED: readonly SetupStepId[] = ["tenant", "google", "source", "facebook", "group"];
const ALL: readonly SetupStepId[] = [...REQUIRED, "firstPost"];

function progressOf(done: Partial<Record<SetupStepId, boolean>>): SetupProgress {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    steps: ALL.map((id) => ({ id, isDone: done[id] ?? false })),
    doneCount: REQUIRED.filter((id) => done[id]).length,
    requiredCount: REQUIRED.length,
    isReady: Boolean(done.source && done.facebook),
  };
}

function viewOf(progress: SetupProgress, id: SetupStepId) {
  return buildStepViews(progress).find((view) => view.id === id);
}

describe("buildStepViews — shape", () => {
  it("returns the six steps in order with their ordinals", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views.map((view) => view.id)).toEqual(ALL);
    expect(views.map((view) => view.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("carries the Vietnamese labels of the design", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views[0]?.title).toBe("Tạo tổ chức");
    expect(views[1]?.title).toBe("Kết nối Google Drive");
    expect(views[2]?.title).toBe("Nối Google Sheet sản phẩm");
    expect(views[3]?.title).toBe("Kết nối trang Facebook");
    expect(views[4]?.title).toBe("Tạo nhóm kênh");
    expect(views[5]?.title).toBe("Đăng bài đầu tiên");
  });

  it("gives every step a screen to open", () => {
    for (const view of buildStepViews(progressOf({}))) {
      expect(view.href.startsWith("/")).toBe(true);
    }
  });
});

describe("buildStepViews — locking", () => {
  it("locks the sheet step until Google Drive is connected, and says why", () => {
    const source = viewOf(progressOf({ tenant: true }), "source");
    expect(source?.state).toBe("locked");
    expect(source?.action?.disabledReason).toBe("Cần kết nối Google Drive trước.");
  });

  it("unlocks the sheet step once Google Drive is connected", () => {
    const source = viewOf(progressOf({ tenant: true, google: true }), "source");
    expect(source?.state).toBe("current");
    expect(source?.action?.disabledReason).toBeNull();
  });

  it("locks the channel group until a Fanpage exists", () => {
    const group = viewOf(progressOf({ tenant: true, google: true }), "group");
    expect(group?.state).toBe("locked");
    expect(group?.action?.disabledReason).toBe("Cần kết nối ít nhất một trang Facebook trước.");
  });

  it("locks the first post until BOTH the sheet source and a Fanpage exist", () => {
    expect(viewOf(progressOf({ tenant: true, google: true, source: true }), "firstPost")?.state).toBe(
      "locked",
    );
    expect(
      viewOf(progressOf({ tenant: true, google: true, source: true, facebook: true }), "firstPost")
        ?.state,
    ).toBe("current");
  });

  it("never locks a step that is already done", () => {
    const progress = progressOf({ tenant: true, source: true, group: true, firstPost: true });
    for (const id of ["source", "group", "firstPost"] as SetupStepId[]) {
      expect(viewOf(progress, id)?.state).toBe("done");
    }
  });

  it("leaves Facebook open from the start — it depends on nothing", () => {
    expect(viewOf(progressOf({}), "facebook")?.state).toBe("current");
  });
});

describe("buildStepViews — what the operator reads", () => {
  it("explains a locked step in its detail line, not only on the dead button", () => {
    expect(viewOf(progressOf({ tenant: true }), "source")?.detail).toBe(
      "Cần kết nối Google Drive trước.",
    );
  });

  it("marks a finished step as done in its detail line", () => {
    expect(viewOf(progressOf({ tenant: true }), "tenant")?.detail).toBe("Đã xong");
  });

  it("shows the estimate on an open step", () => {
    expect(viewOf(progressOf({ tenant: true }), "google")?.detail).toBe("2 ph");
  });

  it("never marks a step optional — all six are the path to a first post", () => {
    for (const view of buildStepViews(progressOf({}))) {
      expect(view.isOptional).toBe(false);
    }
  });
});
