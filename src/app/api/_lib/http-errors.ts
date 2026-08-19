import { AppError, type ErrorCode } from "@/core/domain/errors";

/**
 * Single place translating AppError -> HTTP. Route handlers stay thin:
 * validate -> call usecase -> mapAppErrorToHttp (docs/07 section 3.3).
 */

/** Unified error body. `message` is the Vietnamese operator-facing text. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  /** Field-level issues, only for INVALID_INPUT, so the UI can show them inline. */
  issues?: { path: string; message: string }[];
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  TENANT_NOT_FOUND: 404,
  INTERNAL: 500,
  DB_ERROR: 503,
  QUEUE_ERROR: 503,
  JOB_PAYLOAD_INVALID: 400,
  DRIVE_ERROR: 503,
  SHEET_ERROR: 503,
  FILE_NAME_INVALID: 422,
  SHEET_ROW_INVALID: 422,
  PRODUCT_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
  SYNC_FAILED: 500,
  AI_PROVIDER_ERROR: 502,
  AI_RESPONSE_INVALID: 502,
  AI_RATE_LIMITED: 429,
  AI_BUDGET_EXCEEDED: 429,
  CAPTION_VALIDATION_FAILED: 422,
  MODEL_NOT_CONFIGURED: 500,
  PROMPT_NOT_FOUND: 500,
  META_ERROR: 502,
  TOKEN_EXPIRED: 401,
  // The platform's answer was unusable, not the caller's request.
  UPLOAD_HOST_NOT_ALLOWED: 502,
  CHANNEL_NOT_CONFIGURED: 409,
  DUPLICATE_POST_BLOCKED: 409,
  PUBLISH_FAILED: 502,
  INVALID_JOB_TRANSITION: 409,
  DRAFT_PAYLOAD_REJECTED: 422,
  DRAFT_TOO_LARGE: 413,
  VIDEO_SPEC_INVALID: 422,
  VIDEO_PROBE_FAILED: 422,
  TIKTOK_ERROR: 502,
};

/** Structural logger type — the app layer must not import ports or adapters. */
export type ErrorLogger = {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown> & { err?: unknown }): void;
};

export interface MapErrorOptions {
  logger?: ErrorLogger;
  /** Extra log context: route, tenant_id, job_id... */
  context?: Record<string, unknown>;
}

export function httpStatusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  issues?: ApiErrorBody["issues"],
): Response {
  const body: ApiErrorBody = issues?.length ? { code, message, issues } : { code, message };
  return Response.json(body, { status });
}

/**
 * Never swallow: every mapped error is logged with context before the response.
 * Unknown throwables become 500 INTERNAL — no stack, no cause, no context leaked.
 */
export function mapAppErrorToHttp(error: unknown, options: MapErrorOptions = {}): Response {
  const { logger, context } = options;

  if (AppError.is(error)) {
    const status = httpStatusForCode(error.code);
    const logPayload = { ...context, ...error.toLogObject(), status };
    // 4xx is the caller's fault, not an incident: warn keeps the error channel
    // meaningful for on-call. 5xx keeps `err` attached so the stack is stored.
    if (status >= 500) logger?.error("Request failed with server error", { ...logPayload, err: error });
    else logger?.warn("Request failed with client error", logPayload);

    const issues = extractIssues(error);
    return jsonError(status, error.code, error.userMessage, issues);
  }

  const wrapped = AppError.from(error, "INTERNAL", context);
  logger?.error("Unhandled error in route handler", { ...context, err: wrapped, status: 500 });
  return jsonError(500, "INTERNAL", wrapped.userMessage);
}

/** Pull zod-style issues out of AppError context; ignore anything malformed. */
function extractIssues(error: AppError): ApiErrorBody["issues"] {
  if (error.code !== "INVALID_INPUT") return undefined;
  const raw = (error.context as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return undefined;

  const issues = raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    return [{ path: typeof path === "string" ? path : "", message }];
  });

  return issues.length > 0 ? issues : undefined;
}
