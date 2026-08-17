import { describe, expect, it } from "vitest";

import { NON_RETRYABLE_CODES } from "./bullmq-job-consumer";

/**
 * The retry policy is a decision table, so it is tested as one — starting a real
 * Worker would need a Redis server and belongs to the compose-level check.
 */
describe("NON_RETRYABLE_CODES", () => {
  it.each([
    "JOB_PAYLOAD_INVALID",
    "INVALID_INPUT",
    "TENANT_NOT_FOUND",
    "VIDEO_SPEC_INVALID",
    "VIDEO_PROBE_FAILED",
  ] as const)(
    "fails %s immediately (business error: retrying cannot fix it)",
    (code) => {
      expect(NON_RETRYABLE_CODES.has(code)).toBe(true);
    },
  );

  it.each(["DB_ERROR", "QUEUE_ERROR", "INTERNAL"] as const)(
    "retries %s (transient/unknown: a later attempt can succeed)",
    (code) => {
      expect(NON_RETRYABLE_CODES.has(code)).toBe(false);
    },
  );

  /**
   * Its own test because this entry is what actually stops a duplicate post.
   *
   * When a create request is dispatched and its answer never arrives, the
   * usecase fails the job rather than guessing — but the usecase only owns the
   * ROW. What stops the queue from backing off and sending a second create is
   * this code being here: without it BullMQ retries, the handler runs again,
   * and the job that was stopped precisely because a post might already exist
   * goes and makes another one.
   *
   * Deleting the entry would leave every other test in the suite green, which
   * is why it is pinned on its own with the reason written down.
   */
  it("fails PUBLISH_FAILED immediately — the queue must not resend a create request", () => {
    expect(NON_RETRYABLE_CODES.has("PUBLISH_FAILED")).toBe(true);
  });
});
