/**
 * AppError — the single error type crossing every layer boundary.
 * Pure TypeScript: no imports, no I/O (see docs/07 section 2).
 *
 * Layers add their own codes here as features land. Never throw raw strings
 * or bare Error for business failures.
 */

export const ERROR_CODES = [
  "INVALID_INPUT",
  "INTERNAL",
  "TENANT_NOT_FOUND",
  "UNAUTHORIZED",
  "DB_ERROR",
  "QUEUE_ERROR",
  "JOB_PAYLOAD_INVALID",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured context for logs. Keep it serialisable — never put secrets here. */
export type ErrorContext = Readonly<Record<string, unknown>>;

/** Vietnamese message shown to operators. Every code MUST have one. */
const DEFAULT_USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
  INTERNAL: "Hệ thống gặp sự cố. Vui lòng thử lại sau ít phút.",
  TENANT_NOT_FOUND: "Không tìm thấy đơn vị (tenant) tương ứng.",
  UNAUTHORIZED: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.",
  DB_ERROR: "Không truy cập được cơ sở dữ liệu. Vui lòng thử lại sau ít phút.",
  QUEUE_ERROR: "Hàng đợi công việc gặp sự cố. Vui lòng thử lại sau ít phút.",
  JOB_PAYLOAD_INVALID: "Dữ liệu công việc nền không hợp lệ — công việc đã bị từ chối.",
};

/** English developer message. Falls back to the code itself. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: "Request payload failed schema validation",
  INTERNAL: "Unexpected internal error",
  TENANT_NOT_FOUND: "Tenant not found",
  UNAUTHORIZED: "Missing or invalid credentials",
  DB_ERROR: "Database operation failed",
  QUEUE_ERROR: "Job queue operation failed",
  JOB_PAYLOAD_INVALID: "Job payload failed schema validation",
};

export interface AppErrorOptions {
  /** English, for developers/logs. Defaults to the code's canonical message. */
  message?: string;
  /** Vietnamese, safe to show operators. Defaults to the code's canonical message. */
  userMessage?: string;
  context?: ErrorContext;
  cause?: unknown;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export class AppError extends Error {
  /** Brand: survives duplicated module instances where `instanceof` breaks. */
  readonly _tag = "AppError" as const;
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly context: ErrorContext;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // Guard: an unknown code must not silently produce an error without messages.
    const safeCode: ErrorCode = isErrorCode(code) ? code : "INTERNAL";
    super(options.message ?? DEFAULT_MESSAGES[safeCode], { cause: options.cause });

    this.name = "AppError";
    this.code = safeCode;
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGES[safeCode];
    this.context = options.context ?? {};
  }

  static is(value: unknown): value is AppError {
    if (value instanceof AppError) return true;
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { _tag?: unknown })._tag === "AppError" &&
      isErrorCode((value as { code?: unknown }).code)
    );
  }

  /**
   * Wrap any thrown value into an AppError without losing the original cause.
   * Use at every boundary that catches unknown errors.
   */
  static from(value: unknown, fallback: ErrorCode = "INTERNAL", context?: ErrorContext): AppError {
    if (AppError.is(value)) {
      if (!context) return value;
      return new AppError(value.code, {
        message: value.message,
        userMessage: value.userMessage,
        context: { ...value.context, ...context },
        cause: value.cause ?? value,
      });
    }
    const message = value instanceof Error ? value.message : String(value);
    return new AppError(fallback, { message, context, cause: value });
  }

  /** Log-friendly shape. Never send this to a client as-is (leaks context). */
  toLogObject(): {
    code: ErrorCode;
    message: string;
    userMessage: string;
    context: ErrorContext;
    stack?: string;
    cause?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      stack: this.stack,
      cause: this.cause === undefined ? undefined : String(this.cause),
    };
  }
}
