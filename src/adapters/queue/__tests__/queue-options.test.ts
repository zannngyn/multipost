import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import {
  DEFAULT_JOB_OPTIONS,
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  nextBackoffMs,
  toBullJobOptions,
} from "../queue-options";

/** Pure mapping — no Redis needed. Edge cases first (CLAUDE.md #1). */

function expectQueueError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    return error as AppError;
  }
  throw new Error("expected toBullJobOptions to throw");
}

describe("toBullJobOptions — invalid options", () => {
  const cases: Array<[string, Parameters<typeof toBullJobOptions>[0]]> = [
    ["attempts = 0", { attempts: 0 }],
    ["negative attempts", { attempts: -3 }],
    ["fractional attempts", { attempts: 2.5 }],
    ["negative delayMs", { delayMs: -1 }],
    ["NaN delayMs", { delayMs: Number.NaN }],
    ["negative backoff delay", { backoff: { strategy: "fixed", delayMs: -5 } }],
    [
      "unknown backoff strategy",
      { backoff: { strategy: "linear" as unknown as "fixed", delayMs: 100 } },
    ],
    ["blank jobId", { jobId: "   " }],
    // BullMQ builds Redis keys with ':' and rejects such ids at runtime —
    // our boundary must reject them first, with our own message.
    ["a jobId containing ':'", { jobId: "a:b" }],
    ["the old colon-separated key shape", { jobId: "batch1:AB123:red:fb:image" }],
    ["a jobId with a space", { jobId: "batch1 AB123" }],
    ["a jobId with a slash", { jobId: "batch1/AB123" }],
    ["a jobId with a '*' (Redis scan glob)", { jobId: "batch1*" }],
    ["a jobId longer than 255 chars", { jobId: "a".repeat(256) }],
  ];

  it.each(cases)("rejects %s with QUEUE_ERROR", (_label, opts) => {
    const error = expectQueueError(() => toBullJobOptions(opts));
    expect(error.code).toBe("QUEUE_ERROR");
    expect(error.userMessage).toMatch(/không hợp lệ/i);
  });

  it("names the offending characters so the caller can fix the id", () => {
    const error = expectQueueError(() => toBullJobOptions({ jobId: "batch1:AB123 x" }));
    expect(error.context).toMatchObject({ offending_characters: [":", " "] });
    expect(error.message).toContain("offending characters");
  });
});

describe("toBullJobOptions — defaults", () => {
  it("applies 3 attempts, exponential 1s backoff and the retention caps", () => {
    expect(toBullJobOptions()).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: KEEP_COMPLETED_JOBS,
      removeOnFail: KEEP_FAILED_JOBS,
    });
    expect(KEEP_COMPLETED_JOBS).toBe(100);
    expect(KEEP_FAILED_JOBS).toBe(1_000);
  });

  it("never mutates the shared default object", () => {
    const result = toBullJobOptions({ attempts: 7 });
    expect(result.attempts).toBe(7);
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
  });

  it("keeps defaults for fields the caller did not set", () => {
    expect(toBullJobOptions({ delayMs: 500 })).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: KEEP_COMPLETED_JOBS,
      removeOnFail: KEEP_FAILED_JOBS,
      delay: 500,
    });
  });
});

describe("toBullJobOptions — mapping", () => {
  it("maps port vocabulary to BullMQ vocabulary", () => {
    expect(
      toBullJobOptions({
        attempts: 2,
        backoff: { strategy: "fixed", delayMs: 60_000 },
        delayMs: 90_000.4,
        jobId: "  batch1-AB123-red-fb-image  ",
      }),
    ).toEqual({
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
      removeOnComplete: KEEP_COMPLETED_JOBS,
      removeOnFail: KEEP_FAILED_JOBS,
      delay: 90_000,
      // Trimmed. Dashes, not colons: BullMQ builds Redis keys with ':'.
      jobId: "batch1-AB123-red-fb-image",
    });
  });

  it("accepts the E5 key shape and the rest of the whitelist", () => {
    expect(toBullJobOptions({ jobId: "batch1-AB123-red-fb-image" }).jobId).toBe(
      "batch1-AB123-red-fb-image",
    );
    expect(toBullJobOptions({ jobId: "publish.v2_AB123-01" }).jobId).toBe("publish.v2_AB123-01");
    expect(toBullJobOptions({ jobId: "a".repeat(255) }).jobId).toHaveLength(255);
  });

  it("allows a zero delay and a zero backoff", () => {
    const result = toBullJobOptions({ delayMs: 0, backoff: { strategy: "fixed", delayMs: 0 } });
    expect(result.delay).toBe(0);
    expect(result.backoff).toEqual({ type: "fixed", delay: 0 });
  });
});

describe("nextBackoffMs", () => {
  it("returns undefined before the first failure", () => {
    expect(nextBackoffMs({ type: "exponential", delay: 1_000 }, 0)).toBeUndefined();
  });

  it("doubles the delay for exponential backoff (1s, 2s, 4s)", () => {
    const backoff = { type: "exponential" as const, delay: 1_000 };
    expect(nextBackoffMs(backoff, 1)).toBe(1_000);
    expect(nextBackoffMs(backoff, 2)).toBe(2_000);
    expect(nextBackoffMs(backoff, 3)).toBe(4_000);
  });

  it("keeps a constant delay for fixed backoff", () => {
    const backoff = { type: "fixed" as const, delay: 60_000 };
    expect(nextBackoffMs(backoff, 1)).toBe(60_000);
    expect(nextBackoffMs(backoff, 4)).toBe(60_000);
  });
});
