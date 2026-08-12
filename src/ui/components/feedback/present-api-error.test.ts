import { describe, expect, it } from "vitest";

import { ApiError } from "@/ui/services/api-error";

import { isSystemConfigError, missingConfigKeys, presentApiError, toApiError } from "./present-api-error";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that must never
 * regress: a retry button may only appear where retrying can succeed.
 */

function makeError(params: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    code: "INTERNAL",
    status: 500,
    userMessage: "Lỗi.",
    ...params,
  });
}

describe("toApiError", () => {
  it("passes an ApiError through untouched", () => {
    const original = makeError({ code: "DB_ERROR", status: 503 });
    expect(toApiError(original)).toBe(original);
  });

  it("wraps a thrown Error without losing its message", () => {
    const wrapped = toApiError(new Error("boom"));
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.userMessage).toMatch(/sự cố/i);
  });

  it("wraps a non-Error throwable", () => {
    expect(toApiError("nope").code).toBe("INTERNAL");
  });
});

describe("isSystemConfigError", () => {
  it("detects a missing env var reported as INVALID_INPUT", () => {
    const error = makeError({
      code: "INVALID_INPUT",
      status: 400,
      issues: [{ path: "GOOGLE_AI_API_KEY", message: "GOOGLE_AI_API_KEY is required" }],
    });
    expect(isSystemConfigError(error)).toBe(true);
    expect(missingConfigKeys(error)).toEqual(["GOOGLE_AI_API_KEY"]);
  });

  it("does NOT treat a normal field error as a config problem", () => {
    const error = makeError({
      code: "INVALID_INPUT",
      status: 400,
      issues: [{ path: "productCode", message: "Thiếu mã sản phẩm." }],
    });
    expect(isSystemConfigError(error)).toBe(false);
    expect(missingConfigKeys(error)).toEqual([]);
  });

  it("does not look at issues of other codes", () => {
    const error = makeError({
      code: "DB_ERROR",
      status: 503,
      issues: [{ path: "DATABASE_URL", message: "x" }],
    });
    expect(isSystemConfigError(error)).toBe(false);
  });

  it("survives a missing issues array", () => {
    expect(isSystemConfigError(makeError({ code: "INVALID_INPUT", status: 400 }))).toBe(false);
  });
});

describe("presentApiError", () => {
  it("offers no retry for a system config gap and names the variable", () => {
    const view = presentApiError(
      makeError({
        code: "INVALID_INPUT",
        status: 400,
        issues: [{ path: "GOOGLE_SERVICE_ACCOUNT_JSON", message: "required" }],
      }),
    );
    expect(view.kind).toBe("config");
    expect(view.canRetry).toBe(false);
    expect(view.hint).toContain("GOOGLE_SERVICE_ACCOUNT_JSON");
  });

  it("offers no retry for a validation error and repeats the field message", () => {
    const view = presentApiError(
      makeError({
        code: "INVALID_INPUT",
        status: 400,
        userMessage: "Dữ liệu gửi lên không hợp lệ.",
        issues: [{ path: "productCode", message: "Thiếu mã sản phẩm." }],
      }),
    );
    expect(view.kind).toBe("input");
    expect(view.canRetry).toBe(false);
    expect(view.hint).toContain("Thiếu mã sản phẩm.");
  });

  it.each([
    ["OUT_OF_STOCK", 409],
    ["MEDIA_NOT_FOUND", 404],
    ["PRODUCT_NOT_FOUND", 404],
  ])("treats %s as a business block with no retry", (code, status) => {
    const view = presentApiError(makeError({ code, status, userMessage: "Bị chặn." }));
    expect(view.kind).toBe("business");
    expect(view.canRetry).toBe(false);
  });

  it("allows retrying server-side failures", () => {
    expect(presentApiError(makeError({ code: "DB_ERROR", status: 503 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "DRIVE_ERROR", status: 503 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "AI_PROVIDER_ERROR", status: 502 })).canRetry).toBe(
      true,
    );
  });

  it("routes an expired session to the sign-in path, not to a retry", () => {
    const view = presentApiError(makeError({ code: "UNAUTHORIZED", status: 401 }));
    expect(view.kind).toBe("auth");
    expect(view.canRetry).toBe(false);
  });

  it("falls back to the transport verdict for unknown codes", () => {
    expect(presentApiError(makeError({ code: "SOMETHING_NEW", status: 500 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "SOMETHING_NEW", status: 418 })).canRetry).toBe(false);
    // status 0 = the request never got an answer; retrying is the right move.
    expect(presentApiError(makeError({ code: "NETWORK_ERROR", status: 0 })).canRetry).toBe(true);
  });
});
