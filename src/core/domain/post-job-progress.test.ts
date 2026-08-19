import { describe, expect, it } from "vitest";

import {
  POST_JOB_PROGRESS_STEPS,
  POST_JOB_STAGES,
  POST_JOB_WAITING_STAGES,
  PROGRESS_STEP_NONE,
  applyStageInvariants,
  isPostJobStage,
  postJobProgressMessage,
  progressStepIndex,
  waitingProgress,
  workingProgress,
  type PostJobStage,
  type PostJobWaitingStage,
  type PostJobWorkingStage,
} from "./post-job-progress";

const NOW = new Date("2026-08-17T09:00:00.000Z");

// --- Edge cases first (design §6) -------------------------------------------

describe("workingProgress — counts that do not describe anything", () => {
  it("clamps doneCount > totalCount instead of drawing a bar past 100%", () => {
    const progress = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: 12,
      totalCount: 10,
    });

    expect(progress.doneCount).toBe(10);
    expect(progress.totalCount).toBe(10);
    expect(postJobProgressMessage(progress)).toBe("Đang tải ảnh lên kênh 10/10");
  });

  it("drops both counts when totalCount is 0 (nothing to count, no division by zero)", () => {
    const progress = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: 0,
      totalCount: 0,
    });

    expect(progress.doneCount).toBeNull();
    expect(progress.totalCount).toBeNull();
    expect(postJobProgressMessage(progress)).toBe("Đang tải ảnh lên kênh");
  });

  it("drops both counts when only one of the pair is given (\"3 of ?\" is not progress)", () => {
    const onlyDone = workingProgress("uploading_media", { attempt: 1, now: NOW, doneCount: 3 });
    const onlyTotal = workingProgress("uploading_media", { attempt: 1, now: NOW, totalCount: 10 });

    expect(onlyDone.doneCount).toBeNull();
    expect(onlyDone.totalCount).toBeNull();
    expect(onlyTotal.doneCount).toBeNull();
    expect(onlyTotal.totalCount).toBeNull();
  });

  it("clamps a negative doneCount to 0", () => {
    const progress = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: -4,
      totalCount: 10,
    });

    expect(progress.doneCount).toBe(0);
    expect(progress.totalCount).toBe(10);
  });

  it("ignores non-finite counts", () => {
    const progress = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: Number.NaN,
      totalCount: Number.POSITIVE_INFINITY,
    });

    expect(progress.doneCount).toBeNull();
    expect(progress.totalCount).toBeNull();
  });
});

describe("attempt — a display counter, never a reason to break a post", () => {
  it("turns a negative attempt into 0 and leaves it out of the sentence", () => {
    const progress = workingProgress("checking_stock", { attempt: -3, now: NOW });

    expect(progress.attempt).toBe(0);
    expect(postJobProgressMessage(progress)).toBe(
      "Đang kiểm tra tồn kho lần cuối trước khi đăng",
    );
  });

  it("names the attempt from the second one on", () => {
    const progress = workingProgress("sending_to_channel", { attempt: 2, now: NOW });

    expect(progress.attempt).toBe(2);
    expect(postJobProgressMessage(progress)).toBe("Đang gửi bài lên kênh (lần thử 2)");
  });

  it("floors a fractional attempt", () => {
    expect(workingProgress("checking_stock", { attempt: 2.9, now: NOW }).attempt).toBe(2);
  });
});

describe("waitingProgress — the only place a deadline may come from (§3.2)", () => {
  it("keeps a waitUntil that has already passed instead of rewriting it to now", () => {
    const passed = new Date(NOW.getTime() - 30_000);
    const progress = waitingProgress("waiting_for_spacing", {
      attempt: 1,
      waitUntil: passed,
      now: NOW,
    });

    expect(progress.waitUntil).toEqual(passed);
    expect(progress.waitUntil!.getTime()).toBeLessThan(progress.stageStartedAt.getTime());
  });

  it("reports no countdown at all rather than inventing one for an unusable date", () => {
    const progress = waitingProgress("waiting_for_schedule", {
      attempt: 1,
      waitUntil: new Date(Number.NaN),
      now: NOW,
    });

    expect(progress.waitUntil).toBeNull();
  });

  it("never carries counts", () => {
    const progress = waitingProgress("waiting_on_facebook", {
      attempt: 1,
      waitUntil: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });

    expect(progress.doneCount).toBeNull();
    expect(progress.totalCount).toBeNull();
    expect(progress.currentItem).toBeNull();
  });
});

describe("stageStartedAt", () => {
  it("accepts a now in the future as given — the clock is the caller's business", () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    const progress = workingProgress("reading_channel", { attempt: 1, now: future });

    expect(progress.stageStartedAt).toEqual(future);
    expect(progress.updatedAt).toEqual(future);
  });

  it("replaces an Invalid Date with the epoch instead of poisoning the store", () => {
    const progress = workingProgress("reading_channel", {
      attempt: 1,
      now: new Date("not-a-date"),
    });

    expect(Number.isFinite(progress.stageStartedAt.getTime())).toBe(true);
    expect(progress.stageStartedAt.getTime()).toBe(0);
  });
});

describe("the type-level guarantee of §3.2", () => {
  it("gives every working stage a null waitUntil, with no way to pass one", () => {
    const workingStages = POST_JOB_STAGES.filter(
      (stage): stage is PostJobWorkingStage =>
        !(POST_JOB_WAITING_STAGES as readonly string[]).includes(stage),
    );

    for (const stage of workingStages) {
      const progress = workingProgress(stage, {
        attempt: 1,
        now: NOW,
        // A caller trying to smuggle a deadline in: the extra key is not part of
        // WorkingProgressInput, and it changes nothing.
        ...({ waitUntil: new Date(NOW.getTime() + 60_000) } as Record<string, unknown>),
      });
      expect(progress.waitUntil).toBeNull();
    }
  });

  it("refuses to build a waiting stage through workingProgress", () => {
    // Only reachable from JavaScript or a cast; the fallback keeps the invariant
    // "a waiting stage always came from waitingProgress".
    const progress = workingProgress(
      "waiting_for_spacing" as unknown as PostJobWorkingStage,
      { attempt: 1, now: NOW },
    );

    expect(progress.stage).toBe("waiting_in_queue");
    expect(progress.waitUntil).toBeNull();
  });

  it("drops the deadline when waitingProgress falls back to a working stage", () => {
    // The other direction, and the one that used to leak: the fallback stage is
    // `waiting_in_queue`, which WORKS, so carrying the caller's deadline into it
    // would put a countdown on a working stage.
    const progress = waitingProgress(
      "uploading_media" as unknown as PostJobWaitingStage,
      { attempt: 1, now: NOW, waitUntil: new Date(NOW.getTime() + 60_000) },
    );

    expect(progress.stage).toBe("waiting_in_queue");
    expect(progress.waitUntil).toBeNull();
  });
});

describe("applyStageInvariants — the pairing rule at a boundary", () => {
  const base = {
    attempt: 1,
    stageStartedAt: NOW,
    updatedAt: NOW,
  };

  it("strips a deadline a working stage must never carry", () => {
    // The shape a hand-edited or older-build Redis value can have. Left alone it
    // would draw a countdown on the upload step (§3.2).
    const cleaned = applyStageInvariants({
      ...base,
      stage: "uploading_media",
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
      waitUntil: new Date(NOW.getTime() + 60_000),
    });

    expect(cleaned.waitUntil).toBeNull();
    // The counts are real and are kept — only the invented half goes.
    expect(cleaned).toMatchObject({ doneCount: 3, totalCount: 10, currentItem: "IMG_2041.jpg" });
  });

  it("strips counts a waiting stage must never carry", () => {
    const cleaned = applyStageInvariants({
      ...base,
      stage: "waiting_for_spacing",
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
      waitUntil: new Date(NOW.getTime() + 60_000),
    });

    expect(cleaned).toMatchObject({ doneCount: null, totalCount: null, currentItem: null });
    expect(cleaned.waitUntil).not.toBeNull();
  });

  it("leaves a value the constructors produced untouched", () => {
    const working = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: 3,
      totalCount: 10,
    });
    expect(applyStageInvariants(working)).toEqual(working);

    const waiting = waitingProgress("waiting_for_spacing", {
      attempt: 1,
      now: NOW,
      waitUntil: new Date(NOW.getTime() + 60_000),
    });
    expect(applyStageInvariants(waiting)).toEqual(waiting);
  });
});

// --- Happy path -------------------------------------------------------------

describe("postJobProgressMessage", () => {
  it("produces a Vietnamese sentence for every stage", () => {
    for (const stage of POST_JOB_STAGES) {
      const progress = (POST_JOB_WAITING_STAGES as readonly string[]).includes(stage)
        ? waitingProgress(stage as (typeof POST_JOB_WAITING_STAGES)[number], {
            attempt: 1,
            waitUntil: new Date(NOW.getTime() + 60_000),
            now: NOW,
          })
        : workingProgress(stage as PostJobWorkingStage, { attempt: 1, now: NOW });

      const message = postJobProgressMessage(progress);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/[a-z]_[a-z]/); // no raw stage key leaked
    }
  });

  it("names the file being uploaded (the example of design §5.1)", () => {
    const progress = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
    });

    expect(postJobProgressMessage(progress)).toBe("Đang tải ảnh lên kênh 3/10 (IMG_2041.jpg)");
  });

  it("does not claim a step for an unreadable stage", () => {
    const progress = {
      ...workingProgress("checking_stock", { attempt: 1, now: NOW }),
      stage: "teleporting" as PostJobStage,
    };

    expect(postJobProgressMessage(progress)).toContain("Không rõ");
    expect(progressStepIndex(progress.stage)).toBe(PROGRESS_STEP_NONE);
  });
});

describe("progressStepIndex", () => {
  it("keeps every stage inside the exported stepper, or off it entirely", () => {
    for (const stage of POST_JOB_STAGES) {
      const index = progressStepIndex(stage);
      if (index === PROGRESS_STEP_NONE) {
        expect(stage).toBe("stopped");
        continue;
      }
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(POST_JOB_PROGRESS_STEPS.length);
    }
  });

  it("never moves backwards along the publish order", () => {
    const ordered: PostJobStage[] = [
      "waiting_in_queue",
      "waiting_for_spacing",
      "waiting_for_schedule",
      "checking_stock",
      "reading_channel",
      "checking_video_spec",
      "uploading_media",
      "sending_to_channel",
      "handing_to_facebook",
      "waiting_on_facebook",
      "done",
    ];

    const indexes = ordered.map(progressStepIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

describe("isPostJobStage", () => {
  it("rejects anything that is not one of the known stages", () => {
    expect(isPostJobStage("uploading_media")).toBe(true);
    expect(isPostJobStage("UPLOADING_MEDIA")).toBe(false);
    expect(isPostJobStage("")).toBe(false);
    expect(isPostJobStage(null)).toBe(false);
    expect(isPostJobStage(3)).toBe(false);
  });
});
