/**
 * SDK error -> AppError translation shared by every provider adapter.
 *
 * The gateway routes on `context.failure_kind`, never on a message
 * (docs/ai/provider-strategy.md §1 + §4). ADR-001 names dedicated codes
 * (AI_TIMEOUT/AI_PROVIDER_DOWN/AI_CONTENT_REFUSED/AI_BAD_REQUEST); the shipped
 * `core/domain/errors.ts` only has AI_PROVIDER_ERROR + AI_RATE_LIMITED, so the
 * finer reason travels in the context instead of a new code.
 */

import { AppError, type ErrorCode } from "@/core/domain/errors";
import type { AIFailureKind, AIProviderName } from "@/core/ports/ai";

export interface ProviderErrorContext {
  provider: AIProviderName;
  model: string;
  generationId: string;
  tenantId: string;
  task: string;
  status?: number;
}

/** HTTP status is the only reliable, message-independent classifier. */
export function failureKindFromStatus(status: number | undefined): AIFailureKind {
  if (status === undefined) return "provider_down";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_down";
  return "bad_request";
}

export function codeForFailureKind(kind: AIFailureKind): ErrorCode {
  if (kind === "rate_limited") return "AI_RATE_LIMITED";
  if (kind === "malformed_output") return "AI_RESPONSE_INVALID";
  return "AI_PROVIDER_ERROR";
}

/** Timeouts arrive as aborts, not as HTTP statuses. */
export function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export function toProviderError(
  kind: AIFailureKind,
  message: string,
  context: ProviderErrorContext,
  cause?: unknown,
): AppError {
  return new AppError(codeForFailureKind(kind), {
    message,
    context: {
      provider: context.provider,
      model: context.model,
      tenant_id: context.tenantId,
      generation_id: context.generationId,
      task: context.task,
      status: context.status,
      failure_kind: kind,
    },
    cause,
  });
}
