/**
 * Demo producer — proves the queue path without a UI.
 *
 *   pnpm queue:demo             -> 1 job that succeeds + 1 job that fails twice
 *   pnpm queue:demo --invalid   -> also enqueues a payload that fails validation
 *                                  (must fail once with JOB_PAYLOAD_INVALID, no retry)
 *   pnpm queue:demo --job-id    -> enqueues with a custom job id, then proves a
 *                                  ':' id is rejected by OUR validation boundary,
 *                                  not by the broker
 *   pnpm queue:demo --healthcheck
 *                               -> ONLY the healthcheck-tenant jobs: the seeded
 *                                  demo tenant (succeeds against real Postgres),
 *                                  an unknown tenant (TENANT_NOT_FOUND) and a
 *                                  malformed id (INVALID_INPUT). Both failures
 *                                  are asked for 3 attempts on purpose: they must
 *                                  still run ONCE (unrecoverable, no retry).
 */

import { makeWorkerContainer } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import { ECHO_JOB_NAME } from "./jobs/echo-job";
import { HEALTHCHECK_TENANT_JOB_NAME } from "./jobs/healthcheck-tenant-job";

/**
 * Job ids are the E5 key shape (batch-code-colour-channel-format). Dashes, not
 * colons: BullMQ builds its Redis keys with ':' and rejects such ids.
 */
const VALID_JOB_ID = "batch1-AB123-red-fb-image";
const INVALID_JOB_ID = "a:b";

/** Same fixed id as adapters/db/seed.ts (worker may not import an adapter). */
const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";
/** Valid UUID shape, never seeded — exercises TENANT_NOT_FOUND. */
const UNKNOWN_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
/** Not a UUID — exercises INVALID_INPUT raised by the usecase itself. */
const MALFORMED_TENANT_ID = "not-a-uuid";

/** Retry plan the failing jobs ask for; the point is that it is NOT used. */
const RETRY_IF_IT_WERE_RECOVERABLE = {
  attempts: 3,
  backoff: { strategy: "exponential" as const, delayMs: 1_000 },
};

async function main(): Promise<void> {
  const withInvalid = process.argv.includes("--invalid");
  const withJobId = process.argv.includes("--job-id");
  const healthcheckOnly = process.argv.includes("--healthcheck");
  const { queue, logger, close } = makeWorkerContainer();
  const log = logger.child({ component: "enqueue-demo" });

  if (healthcheckOnly) {
    try {
      const ok = await queue.enqueue(HEALTHCHECK_TENANT_JOB_NAME, { tenantId: DEMO_TENANT_ID });
      log.info("enqueued healthcheck job for the seeded tenant", {
        job_id: ok.jobId,
        tenant_id: DEMO_TENANT_ID,
        expect: "succeeds on attempt 1, logs tenant name + status from Postgres",
      });

      const notFound = await queue.enqueue(
        HEALTHCHECK_TENANT_JOB_NAME,
        { tenantId: UNKNOWN_TENANT_ID },
        RETRY_IF_IT_WERE_RECOVERABLE,
      );
      log.info("enqueued healthcheck job for an unknown tenant", {
        job_id: notFound.jobId,
        tenant_id: UNKNOWN_TENANT_ID,
        expect: "TENANT_NOT_FOUND on attempt 1, unrecoverable — no attempt 2 or 3",
      });

      const malformed = await queue.enqueue(
        HEALTHCHECK_TENANT_JOB_NAME,
        { tenantId: MALFORMED_TENANT_ID },
        RETRY_IF_IT_WERE_RECOVERABLE,
      );
      log.info("enqueued healthcheck job with a malformed tenant id", {
        job_id: malformed.jobId,
        tenant_id: MALFORMED_TENANT_ID,
        expect: "INVALID_INPUT on attempt 1, unrecoverable — no attempt 2 or 3",
      });
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        component: "enqueue-demo",
        mode: "healthcheck",
      });
      log.error("healthcheck enqueue demo failed", { err: appError });
      await close();
      throw appError;
    }

    await close();
    return;
  }

  try {
    const ok = await queue.enqueue(ECHO_JOB_NAME, { message: "hello from enqueue-demo" });
    log.info("enqueued ok job", { job_id: ok.jobId, expect: "succeeds on attempt 1" });

    const retrying = await queue.enqueue(
      ECHO_JOB_NAME,
      { message: "this one retries", failTimes: 2 },
      { attempts: 3, backoff: { strategy: "exponential", delayMs: 1_000 } },
    );
    log.info("enqueued retrying job", {
      job_id: retrying.jobId,
      expect: "fails attempts 1-2 (backoff ~1s, ~2s), succeeds on attempt 3",
    });

    if (withJobId) {
      const custom = await queue.enqueue(
        ECHO_JOB_NAME,
        { message: `custom job id ${VALID_JOB_ID}` },
        { jobId: VALID_JOB_ID },
      );
      log.info("enqueued job with custom id", {
        job_id: custom.jobId,
        expect: "accepted by the broker, succeeds on attempt 1",
      });

      // A ':' id must be refused BEFORE the broker sees it.
      try {
        await queue.enqueue(ECHO_JOB_NAME, { message: "never reaches redis" }, {
          jobId: INVALID_JOB_ID,
        });
        throw new AppError("INTERNAL", {
          message: `Expected jobId "${INVALID_JOB_ID}" to be rejected by validation`,
          context: { job_id: INVALID_JOB_ID },
        });
      } catch (error) {
        // Only the expected validation failure is tolerated; anything else bubbles up.
        const appError = AppError.from(error, "INTERNAL", { job_id: INVALID_JOB_ID });
        const isExpected =
          appError.code === "QUEUE_ERROR" && appError.message.includes("offending characters");
        if (!isExpected) throw appError;
        log.info("invalid job id rejected at the validation boundary", {
          job_id: INVALID_JOB_ID,
          error_code: appError.code,
          error_message: appError.message,
          offending_characters: (appError.context as { offending_characters?: unknown })
            .offending_characters,
        });
      }
    }

    if (withInvalid) {
      const invalid = await queue.enqueue(ECHO_JOB_NAME, { message: "" });
      log.info("enqueued invalid job", {
        job_id: invalid.jobId,
        expect: "JOB_PAYLOAD_INVALID, failed without retry",
      });
    }
  } catch (error) {
    const appError = AppError.from(error, "QUEUE_ERROR", { component: "enqueue-demo" });
    log.error("enqueue demo failed", { err: appError });
    await close();
    throw appError;
  }

  await close();
}

main().catch((error: unknown) => {
  const appError = AppError.from(error, "QUEUE_ERROR");
  process.stderr.write(`${JSON.stringify({ level: "fatal", err: appError.toLogObject() })}\n`);
  process.exit(1);
});
