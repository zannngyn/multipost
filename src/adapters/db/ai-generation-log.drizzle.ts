import { AppError } from "@/core/domain/errors";
import type { GenerationLog, GenerationLogEntry } from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { aiGenerations } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * `ai_generation` writer — ONE ROW PER ATTEMPT, successes and failures alike
 * (docs/ai/prompt-versioning.md §2). Replaces the log-only implementation: the
 * dashboard questions (cost per published post, pass rate per model, fallback
 * rate) need SQL, not grep.
 *
 * Failure policy: this method THROWS on a database error, with full context
 * logged first. It does not decide whether a generation dies — the gateway
 * catches, logs and continues, so a logging outage cannot destroy a caption
 * that was already produced and validated. The error is never swallowed here.
 */

export interface DrizzleGenerationLogDeps {
  db: Database;
  logger: Logger;
  /** Row id generator (core never calls randomUUID itself). */
  newId: () => string;
}

/** Status of one attempt, derived from the two independent outcomes. */
function statusOf(entry: GenerationLogEntry): "passed" | "validation_failed" | "provider_error" {
  if (!entry.success) return "provider_error";
  return entry.validationPassed === true ? "passed" : "validation_failed";
}

function firstFailedStage(entry: GenerationLogEntry): number | null {
  const stages = (entry.validationFailures ?? []).map((failure) => failure.stage);
  return stages.length === 0 ? null : Math.min(...stages);
}

/** A malformed ISO string must not become `Invalid Date` inside a timestamp column. */
function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function makeDrizzleGenerationLog(deps: DrizzleGenerationLogDeps): GenerationLog {
  return {
    async record(entry: GenerationLogEntry): Promise<void> {
      // --- Edge cases first ------------------------------------------------
      if (!entry || typeof entry.generationId !== "string" || entry.generationId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "GenerationLogEntry requires a generationId",
          context: { tenant_id: entry?.tenantId ?? null, task: entry?.task ?? null },
        });
      }

      const scope = forTenant(deps.db, entry.tenantId);
      const status = statusOf(entry);

      try {
        await scope.db.insert(aiGenerations).values(
          scope.row({
            id: deps.newId(),
            generationId: entry.generationId,
            attemptNo: entry.attemptNo,
            requestId: entry.requestId ?? null,
            task: entry.task,
            tier: entry.tier,
            provider: entry.provider,
            model: entry.model,
            promptTemplateId: entry.promptTemplateId,
            promptVersion: entry.promptVersion,
            status,
            failureKind: entry.failureKind ?? null,
            errorCode: entry.errorCode ?? null,
            validationStageFailed: status === "passed" ? null : firstFailedStage(entry),
            fallbackUsed: entry.fallbackUsed,
            escalationFrom: entry.escalationFrom,
            inputHash: entry.inputHash,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cachedTokens: entry.cachedTokens,
            latencyMs: entry.latencyMs,
            costUsd: entry.estimatedCostUsd,
            validationFailures: entry.validationFailures
              ? entry.validationFailures.map((failure) => ({
                  stage: failure.stage,
                  rule: failure.rule,
                  message: failure.message,
                }))
              : null,
            output: entry.output === undefined ? null : entry.output,
            postJobId: entry.postJobId ?? null,
            batchId: entry.batchId ?? null,
            productCode: entry.productCode ?? null,
            channelId: entry.channelId ?? null,
            createdAt: toDate(entry.createdAt),
          }),
        );
      } catch (error) {
        const appError = wrapDbError(error, {
          operation: "aiGeneration.record",
          tenant_id: scope.tenantId,
          generation_id: entry.generationId,
          attempt_no: entry.attemptNo,
          task: entry.task,
          provider: entry.provider,
          model: entry.model,
          tier: entry.tier,
          status,
        });
        // Logged here with the full row context, rethrown for the caller to
        // decide: the gateway keeps the generation alive, a script does not.
        deps.logger.error("Failed to insert ai_generation row", {
          error_code: appError.code,
          tenant_id: scope.tenantId,
          generation_id: entry.generationId,
          attempt_no: entry.attemptNo,
          task: entry.task,
          provider: entry.provider,
          model: entry.model,
          tier: entry.tier,
          status,
          err: appError,
        });
        throw appError;
      }
    },
  };
}
