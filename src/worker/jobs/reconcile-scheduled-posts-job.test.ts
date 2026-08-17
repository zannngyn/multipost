import { describe, expect, it, vi } from "vitest";

import type { Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import {
  RECONCILE_SCHEDULED_POSTS_JOB_NAME,
  makeReconcileScheduledPostsHandler,
  parseReconcileScheduledPostsPayload,
} from "./reconcile-scheduled-posts-job";

/** Edge cases first: a scheduler tick is external input like any other job. */

function fakeLogger() {
  const logger = {
    child: vi.fn(() => logger as unknown as Logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function envelope(payload: unknown, attempt = 1) {
  return {
    jobId: "reconcile-tick-1",
    jobName: RECONCILE_SCHEDULED_POSTS_JOB_NAME,
    payload,
    attempt,
    maxAttempts: 1,
  };
}

const EMPTY_RESULT = {
  scanned: 0,
  published: 0,
  waiting: 0,
  blocked: 0,
  failed: 0,
  skipped: 0,
  jobs: [],
  durationMs: 2,
};

describe("parseReconcileScheduledPostsPayload", () => {
  it.each([undefined, null, {}])("accepts the empty tick %p (use the defaults)", (raw) => {
    expect(parseReconcileScheduledPostsPayload(raw)).toEqual({});
  });

  it("accepts the three overrides", () => {
    expect(
      parseReconcileScheduledPostsPayload({ graceMs: 60_000, giveUpMs: 3_600_000, limit: 10 }),
    ).toEqual({ graceMs: 60_000, giveUpMs: 3_600_000, limit: 10 });
  });

  it.each([
    ["a negative grace", { graceMs: -1 }],
    ["a zero limit", { limit: 0 }],
    ["a limit above the cap", { limit: 5_000 }],
    ["an unknown key (producer and worker disagree)", { everyMs: 1_000 }],
    ["a string payload", "now"],
    ["an array", []],
  ])("rejects %s with JOB_PAYLOAD_INVALID", (_label, raw) => {
    try {
      parseReconcileScheduledPostsPayload(raw, { queue_job_id: "tick" });
      throw new Error("expected parseReconcileScheduledPostsPayload to throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("JOB_PAYLOAD_INVALID");
      expect((error as AppError).context).toMatchObject({
        job_name: RECONCILE_SCHEDULED_POSTS_JOB_NAME,
      });
    }
  });
});

describe("makeReconcileScheduledPostsHandler", () => {
  it("passes the overrides through and logs the tick receipt", async () => {
    const reconcileScheduledPosts = vi.fn(async () => ({
      ...EMPTY_RESULT,
      scanned: 2,
      published: 1,
      waiting: 1,
    }));
    const logger = fakeLogger();
    const handler = makeReconcileScheduledPostsHandler({
      logger: logger as unknown as Logger,
      reconcileScheduledPosts:
        reconcileScheduledPosts as unknown as Usecases["reconcileScheduledPosts"],
    });

    await handler(envelope({ limit: 10 }));

    expect(reconcileScheduledPosts).toHaveBeenCalledWith({ limit: 10 });
    expect(logger.info).toHaveBeenCalledWith(
      "reconcile-scheduled-posts tick done",
      expect.objectContaining({ scanned: 2, published: 1, waiting: 1 }),
    );
  });

  it("rejects a malformed payload BEFORE calling the sweep", async () => {
    const reconcileScheduledPosts = vi.fn(async () => EMPTY_RESULT);
    const handler = makeReconcileScheduledPostsHandler({
      logger: fakeLogger() as unknown as Logger,
      reconcileScheduledPosts:
        reconcileScheduledPosts as unknown as Usecases["reconcileScheduledPosts"],
    });

    await expect(handler(envelope({ nope: 1 }))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
    });
    expect(reconcileScheduledPosts).not.toHaveBeenCalled();
  });

  it("logs with an alert and rethrows when the sweep itself fails", async () => {
    const logger = fakeLogger();
    const handler = makeReconcileScheduledPostsHandler({
      logger: logger as unknown as Logger,
      reconcileScheduledPosts: (async () => {
        throw new AppError("DB_ERROR", { message: "db down" });
      }) as unknown as Usecases["reconcileScheduledPosts"],
    });

    await expect(handler(envelope({}))).rejects.toMatchObject({ code: "DB_ERROR" });
    expect(logger.error).toHaveBeenCalledWith(
      "reconcile-scheduled-posts tick failed",
      expect.objectContaining({ alert: "OPERATOR_ATTENTION" }),
    );
  });
});
