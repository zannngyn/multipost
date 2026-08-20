import { z } from "zod";

import { systemTenantId } from "@/composition/system-tenant-id";
import type { JobEnvelope, JobHandler, Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * First job that runs a REAL usecase: it closes the worker half of the walking
 * skeleton (worker -> composition -> usecase -> repo -> Postgres).
 *
 * The handler stays thin (docs/07 §2): validate the payload at the boundary,
 * call the usecase, log the outcome. No business rule lives here.
 */

export const HEALTHCHECK_TENANT_JOB_NAME = "healthcheck-tenant";

/**
 * `.strict()`: an unknown key means the producer and this worker disagree about
 * the contract — fail loudly instead of silently ignoring the extra field.
 * The UUID shape is NOT checked here on purpose: it is a domain rule owned by
 * the usecase, which answers with INVALID_INPUT (also non-retryable).
 */
export const HealthcheckTenantPayloadSchema = z
  .object({
    tenantId: z.string().trim().min(1, "tenantId must not be empty"),
  })
  .strict();

export type HealthcheckTenantPayload = z.infer<typeof HealthcheckTenantPayloadSchema>;

/**
 * Job data comes from Redis — external input, never trusted.
 * A bad payload is permanent: JOB_PAYLOAD_INVALID is in the consumer's
 * non-retryable set, so BullMQ fails it without burning retries.
 */
export function parseHealthcheckTenantPayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): HealthcheckTenantPayload {
  const parsed = HealthcheckTenantPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid healthcheck-tenant payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage:
      "Dữ liệu công việc kiểm tra đơn vị không hợp lệ — công việc đã bị từ chối, không thử lại.",
    context: { ...context, job_name: HEALTHCHECK_TENANT_JOB_NAME, issues },
  });
}

export interface HealthcheckTenantHandlerDeps {
  logger: Logger;
  healthcheckTenant: Usecases["healthcheckTenant"];
}

export function makeHealthcheckTenantHandler(deps: HealthcheckTenantHandlerDeps): JobHandler {
  return async function handleHealthcheckTenant(job: JobEnvelope): Promise<void> {
    // Throws before any logger.child({ tenant_id }): there is no trustworthy
    // tenant id to bind yet.
    const payload = parseHealthcheckTenantPayload(job.payload, {
      job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      job_id: job.jobId,
      job_name: HEALTHCHECK_TENANT_JOB_NAME,
      tenant_id: payload.tenantId,
      attempt: job.attempt,
    });

    try {
      const result = await deps.healthcheckTenant({
        tenantId: systemTenantId(payload, { component: "healthcheck-tenant" }),
      });
      // tenant_id is already bound on `log` — repeating it would emit the key
      // twice in one JSON line.
      log.info("healthcheck-tenant job done", {
        tenant_name: result.name,
        status: result.status,
        checked_at: result.checkedAt,
      });
    } catch (error) {
      // Never swallowed: log with context, then rethrow so the queue adapter
      // decides retry vs. unrecoverable from the error CODE alone
      // (TENANT_NOT_FOUND/INVALID_INPUT: no retry — DB_ERROR: retry + backoff).
      const appError = AppError.from(error, "INTERNAL", {
        job_id: job.jobId,
        job_name: HEALTHCHECK_TENANT_JOB_NAME,
        tenant_id: payload.tenantId,
        attempt: job.attempt,
        max_attempts: job.maxAttempts,
      });
      log.error("healthcheck-tenant job failed", {
        err: appError,
        error_code: appError.code,
        user_message: appError.userMessage,
      });
      throw appError;
    }
  };
}
