import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import { isRetryableAppError, mapGraphError } from "./graph-error-map";

/**
 * E5.5 — the table an operator's error message comes from. Every row asserts
 * the AppError code, whether a retry makes sense, and that a Vietnamese message
 * exists (an English Graph string is useless on the operations screen).
 */

describe("mapGraphError", () => {
  const rows: Array<{
    label: string;
    input: Parameters<typeof mapGraphError>[0];
    code: "TOKEN_EXPIRED" | "META_ERROR";
    retryable: boolean;
    reason: string;
  }> = [
    {
      label: "190 expired token",
      input: { error: { code: 190, error_subcode: 463, message: "Session has expired" } },
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "TOKEN_INVALID",
    },
    {
      label: "190/458 app removed",
      input: { error: { code: 190, error_subcode: 458 } },
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "APP_REMOVED",
    },
    {
      label: "4 app request limit",
      input: { error: { code: 4 } },
      code: "META_ERROR",
      retryable: true,
      reason: "RATE_LIMITED",
    },
    {
      label: "17 user request limit",
      input: { error: { code: 17 } },
      code: "META_ERROR",
      retryable: true,
      reason: "RATE_LIMITED",
    },
    {
      label: "613 calls exceeded",
      input: { error: { code: 613 } },
      code: "META_ERROR",
      retryable: true,
      reason: "RATE_LIMITED",
    },
    {
      label: "200 permission denied",
      input: { error: { code: 200, message: "Permissions error" } },
      code: "META_ERROR",
      retryable: false,
      reason: "PERMISSION_DENIED",
    },
    {
      label: "100 invalid parameter",
      input: { error: { code: 100, message: "Invalid parameter" } },
      code: "META_ERROR",
      retryable: false,
      reason: "INVALID_PARAMETER",
    },
    {
      // A failed download is intermittent, not permanent: it must be retried.
      label: "1609005 image could not be fetched",
      input: { error: { code: 1609005 } },
      code: "META_ERROR",
      retryable: true,
      reason: "MEDIA_FETCH_FAILED",
    },
    {
      label: "324 missing or invalid image file",
      input: {
        error: {
          code: 324,
          error_subcode: 2069019,
          type: "OAuthException",
          message: "Missing or invalid image file",
          is_transient: true,
        },
        httpStatus: 400,
      },
      code: "META_ERROR",
      retryable: true,
      reason: "MEDIA_FETCH_FAILED",
    },
    {
      label: "324 without the transient flag is still a media fetch failure",
      input: { error: { code: 324 }, httpStatus: 400 },
      code: "META_ERROR",
      retryable: true,
      reason: "MEDIA_FETCH_FAILED",
    },
    {
      label: "unknown code flagged is_transient",
      input: { error: { code: 999999, is_transient: true }, httpStatus: 400 },
      code: "META_ERROR",
      retryable: true,
      reason: "TRANSIENT_FLAGGED",
    },
    {
      label: "unknown code without the flag stays permanent",
      input: { error: { code: 999999 }, httpStatus: 400 },
      code: "META_ERROR",
      retryable: false,
      reason: "HTTP_CLIENT_ERROR",
    },
    {
      label: "unknown code flagged is_transient with no HTTP status at all",
      input: { error: { code: 999999, is_transient: true } },
      code: "META_ERROR",
      retryable: true,
      reason: "TRANSIENT_FLAGGED",
    },
    {
      // Regression: Meta flags dead tokens as transient too. Retrying a dead
      // token burns attempts and delays the alert to the operator.
      label: "190 flagged is_transient is still a dead token",
      input: { error: { code: 190, is_transient: true }, httpStatus: 401 },
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "TOKEN_INVALID",
    },
    {
      label: "200 flagged is_transient is still a permission problem",
      input: { error: { code: 200, is_transient: true }, httpStatus: 403 },
      code: "META_ERROR",
      retryable: false,
      reason: "PERMISSION_DENIED",
    },
    {
      // BY_CODE must keep winning over the flag: these go red if the
      // is_transient branch is ever moved above the table lookup.
      label: "100 flagged is_transient is still a rejected payload",
      input: { error: { code: 100, is_transient: true }, httpStatus: 400 },
      code: "META_ERROR",
      retryable: false,
      reason: "INVALID_PARAMETER",
    },
    {
      label: "368 flagged is_transient is still a page-level block",
      input: { error: { code: 368, is_transient: true }, httpStatus: 400 },
      code: "META_ERROR",
      retryable: false,
      reason: "TEMPORARILY_BLOCKED",
    },
    {
      label: "unknown code flagged is_transient on a 401 is still an auth failure",
      input: { error: { code: 999999, is_transient: true }, httpStatus: 401 },
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "HTTP_UNAUTHORIZED",
    },
    {
      label: "368 temporarily blocked",
      input: { error: { code: 368 } },
      code: "META_ERROR",
      retryable: false,
      reason: "TEMPORARILY_BLOCKED",
    },
    {
      label: "2 temporary platform error",
      input: { error: { code: 2 }, httpStatus: 500 },
      code: "META_ERROR",
      retryable: true,
      reason: "TEMPORARY_PLATFORM_ERROR",
    },
    {
      label: "HTTP 429 without a body code",
      input: { httpStatus: 429 },
      code: "META_ERROR",
      retryable: true,
      reason: "HTTP_RATE_LIMITED",
    },
    {
      label: "HTTP 503 without a body code",
      input: { httpStatus: 503 },
      code: "META_ERROR",
      retryable: true,
      reason: "HTTP_SERVER_ERROR",
    },
    {
      label: "HTTP 401 without a body code",
      input: { httpStatus: 401 },
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "HTTP_UNAUTHORIZED",
    },
    {
      label: "HTTP 400 without a body code",
      input: { httpStatus: 400 },
      code: "META_ERROR",
      retryable: false,
      reason: "HTTP_CLIENT_ERROR",
    },
    {
      label: "network failure (no answer at all)",
      input: { cause: new Error("fetch failed") },
      code: "META_ERROR",
      retryable: true,
      reason: "NETWORK_ERROR",
    },
    {
      label: "nothing usable at all",
      input: {},
      code: "META_ERROR",
      retryable: false,
      reason: "UNKNOWN",
    },
  ];

  it.each(rows)("$label -> $code (retryable=$retryable)", ({ input, code, retryable, reason }) => {
    const error = mapGraphError(input);
    expect(AppError.is(error)).toBe(true);
    expect(error.code).toBe(code);
    expect(error.context).toMatchObject({ retryable, reason });
    expect(isRetryableAppError(error)).toBe(retryable);
    // Vietnamese message with real diacritics, not an English passthrough.
    expect(error.userMessage.length).toBeGreaterThan(10);
    expect(error.userMessage).toMatch(/[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i);
  });

  it("keeps the original codes in the context so the log names the real cause", () => {
    const error = mapGraphError({
      error: { code: 190, error_subcode: 463, message: "Error validating access token", fbtrace_id: "A1" },
      httpStatus: 401,
      context: { tenant_id: "t1", channel: "fbpage-a" },
    });
    expect(error.context).toMatchObject({
      tenant_id: "t1",
      channel: "fbpage-a",
      graph_code: 190,
      graph_subcode: 463,
      fbtrace_id: "A1",
      http_status: 401,
    });
    expect(error.message).toContain("code=190");
  });

  it("keeps the transient flag in the context so the log explains the retry", () => {
    const error = mapGraphError({
      error: { code: 324, error_subcode: 2069019, is_transient: true, fbtrace_id: "B2" },
      httpStatus: 400,
      context: { job_id: "j1" },
    });
    expect(error.context).toMatchObject({
      job_id: "j1",
      graph_code: 324,
      graph_subcode: 2069019,
      graph_is_transient: true,
      retryable: true,
    });
  });

  it("reports no transient flag as null instead of a guessed false", () => {
    const error = mapGraphError({ error: { code: 100 }, httpStatus: 400 });
    expect(error.context).toMatchObject({ graph_is_transient: null });
  });

  it("never leaks a token: only the fields we pass in reach the context", () => {
    const error = mapGraphError({ error: { code: 190 }, context: { channel: "fbpage-a" } });
    expect(JSON.stringify(error.context)).not.toMatch(/access_token|EAA/);
  });
});
