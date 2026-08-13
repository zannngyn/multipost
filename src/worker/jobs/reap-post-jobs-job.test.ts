import { describe, expect, it, vi } from "vitest";

import type { Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import {
  REAP_POST_JOBS_JOB_NAME,
  makeReapPostJobsHandler,
  parseReapPostJobsPayload,
} from "./reap-post-jobs-job";

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
    jobId: "reaper-tick-1",
    jobName: REAP_POST_JOBS_JOB_NAME,
    payload,
    attempt,
    maxAttempts: 1,
  };
}

const EMPTY_RESULT = {
  scannedStalePublishing: 0,
  scannedOverdueQueued: 0,
  failed: 0,
  requeued: 0,
  skipped: 0,
  jobs: [],
  durationMs: 3,
};

describe("parseReapPostJobsPayload", () => {
  it.each([undefined, null, {}])("accepts the empty tick %p (use the defaults)", (raw) => {
    expect(parseReapPostJobsPayload(raw)).toEqual({});
  });

  it("accepts the three overrides", () => {
    expect(
      parseReapPostJobsPayload({ publishingStaleMs: 60_000, overdueQueuedMs: 1_000, limit: 10 }),
    ).toEqual({ publishingStaleMs: 60_000, overdueQueuedMs: 1_000, limit: 10 });
  });

  it.each([
    ["a negative threshold", { publishingStaleMs: -1 }],
    ["a zero limit", { limit: 0 }],
    ["a limit above the cap", { limit: 5_000 }],
    ["an unknown key (producer and worker disagree)", { everyMs: 1_000 }],
    ["a string payload", "now"],
    ["an array", []],
  ])("rejects %s with JOB_PAYLOAD_INVALID", (_label, raw) => {
    try {
      parseReapPostJobsPayload(raw, { queue_job_id: "tick" });
      throw new Error("expected parseReapPostJobsPayload to throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("JOB_PAYLOAD_INVALID");
      expect((error as AppError).context).toMatchObject({ job_name: REAP_POST_JOBS_JOB_NAME });
    }
  });
});

describe("makeReapPostJobsHandler", () => {
  it("passes the overrides through and logs the tick receipt", async () => {
    const reapPostJobs = vi.fn(async () => ({ ...EMPTY_RESULT, failed: 1, requeued: 2 }));
    const logger = fakeLogger();
    const handler = makeReapPostJobsHandler({
      logger: logger as unknown as Logger,
      reapPostJobs: reapPostJobs as unknown as Usecases["reapPostJobs"],
    });

    await handler(envelope({ limit: 10 }));

    expect(reapPostJobs).toHaveBeenCalledWith({ limit: 10 });
    expect(logger.info).toHaveBeenCalledWith(
      "post-job-reaper tick done",
      expect.objectContaining({ failed: 1, requeued: 2 }),
    );
  });

  it("rejects a malformed payload BEFORE calling the sweep", async () => {
    const reapPostJobs = vi.fn(async () => EMPTY_RESULT);
    const handler = makeReapPostJobsHandler({
      logger: fakeLogger() as unknown as Logger,
      reapPostJobs: reapPostJobs as unknown as Usecases["reapPostJobs"],
    });

    await expect(handler(envelope({ nope: 1 }))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
    });
    expect(reapPostJobs).not.toHaveBeenCalled();
  });

  it("logs with an alert and rethrows when the sweep itself fails", async () => {
    const logger = fakeLogger();
    const handler = makeReapPostJobsHandler({
      logger: logger as unknown as Logger,
      reapPostJobs: (async () => {
        throw new AppError("DB_ERROR", { message: "db down" });
      }) as unknown as Usecases["reapPostJobs"],
    });

    await expect(handler(envelope({}))).rejects.toMatchObject({ code: "DB_ERROR" });
    expect(logger.error).toHaveBeenCalledWith(
      "post-job-reaper tick failed",
      expect.objectContaining({ alert: "OPERATOR_ATTENTION" }),
    );
  });
});
