/**
 * Typed error for the UI data layer.
 *
 * Mirrors `AppError` on the server, but cannot reuse it: `ui/` may not import
 * `core/` (one-way dependency law, docs/07 §2). It carries the server error
 * code plus a Vietnamese message that is always safe to render.
 */

/** Codes the UI itself produces; server codes arrive as free-form strings. */
export const CLIENT_ERROR_CODES = {
  /** Request never reached the server (offline, DNS, CORS, abort). */
  NETWORK: "NETWORK_ERROR",
  /** Request exceeded the client timeout. */
  TIMEOUT: "TIMEOUT",
  /** Server answered, but not in the shape we agreed on. */
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
} as const;

export class ApiError extends Error {
  readonly code: string;
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  /** Vietnamese, safe to show operators. */
  readonly userMessage: string;
  /** Field-level issues, present for INVALID_INPUT. */
  readonly issues?: { path: string; message: string }[];

  constructor(params: {
    code: string;
    status: number;
    userMessage: string;
    message?: string;
    issues?: { path: string; message: string }[];
    cause?: unknown;
  }) {
    super(params.message ?? `${params.code} (HTTP ${params.status})`, { cause: params.cause });
    this.name = "ApiError";
    this.code = params.code;
    this.status = params.status;
    this.userMessage = params.userMessage;
    this.issues = params.issues;
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }

  /**
   * Retrying a 4xx sends the exact same bad request — the button would be a lie
   * (core-feedback-states: no retry for errors that cannot succeed).
   */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}
