import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import { ECHO_JOB_NAME, makeEchoHandler, parseEchoPayload } from "../echo-job";

/** Edge cases first (CLAUDE.md #1): every way a job payload can be wrong. */

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
  return { jobId: "job-1", jobName: ECHO_JOB_NAME, payload, attempt, maxAttempts: 3 };
}

describe("parseEchoPayload — invalid input", () => {
  const invalidCases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a string instead of an object", "hello"],
    ["an array", []],
    ["an empty object", {}],
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   " }],
    ["a non-string message", { message: 42 }],
    ["a negative failTimes", { message: "hi", failTimes: -1 }],
    ["a fractional failTimes", { message: "hi", failTimes: 1.5 }],
    ["a failTimes above the cap", { message: "hi", failTimes: 99 }],
    ["an unknown extra key", { message: "hi", tenantId: "t1" }],
  ];

  it.each(invalidCases)("rejects %s with JOB_PAYLOAD_INVALID", (_label, raw) => {
    try {
      parseEchoPayload(raw, { job_id: "job-1" });
      throw new Error("expected parseEchoPayload to throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.code).toBe("JOB_PAYLOAD_INVALID");
      expect(appError.userMessage).toMatch(/không hợp lệ/i);
      expect(appError.context).toMatchObject({ job_id: "job-1", job_name: ECHO_JOB_NAME });
      expect(Array.isArray((appError.context as { issues?: unknown }).issues)).toBe(true);
    }
  });
});

describe("parseEchoPayload — valid input", () => {
  it("trims the message and keeps failTimes optional", () => {
    expect(parseEchoPayload({ message: "  hello  " })).toEqual({ message: "hello" });
    expect(parseEchoPayload({ message: "hello", failTimes: 0 })).toEqual({
      message: "hello",
      failTimes: 0,
    });
    expect(parseEchoPayload({ message: "hello", failTimes: 2 })).toEqual({
      message: "hello",
      failTimes: 2,
    });
  });
});

describe("makeEchoHandler", () => {
  it("throws a retryable INTERNAL error while attempts are below failTimes", async () => {
    const handler = makeEchoHandler(fakeLogger() as unknown as Logger);

    await expect(handler(envelope({ message: "hi", failTimes: 2 }, 1))).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(handler(envelope({ message: "hi", failTimes: 2 }, 2))).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("succeeds once the attempt exceeds failTimes", async () => {
    const logger = fakeLogger();
    const handler = makeEchoHandler(logger as unknown as Logger);

    await expect(handler(envelope({ message: "hi", failTimes: 2 }, 3))).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      "echo job done",
      expect.objectContaining({ job_id: "job-1", attempt: 3, message: "hi" }),
    );
  });

  it("propagates JOB_PAYLOAD_INVALID for a bad payload before doing any work", async () => {
    const logger = fakeLogger();
    const handler = makeEchoHandler(logger as unknown as Logger);

    await expect(handler(envelope({ message: "" }, 1))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
