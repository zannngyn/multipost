import { describe, expect, it } from "vitest";

import { NON_RETRYABLE_CODES } from "./bullmq-job-consumer";

/**
 * The retry policy is a decision table, so it is tested as one — starting a real
 * Worker would need a Redis server and belongs to the compose-level check.
 */
describe("NON_RETRYABLE_CODES", () => {
  it.each(["JOB_PAYLOAD_INVALID", "INVALID_INPUT", "TENANT_NOT_FOUND"] as const)(
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
});
