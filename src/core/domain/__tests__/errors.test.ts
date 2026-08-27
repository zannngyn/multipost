import { describe, expect, it } from "vitest";

import { AppError, ERROR_CODES, isErrorCode, type ErrorCode } from "../errors";

describe("AppError — edge cases", () => {
  it("falls back to INTERNAL when the code is not in the registry", () => {
    // Simulates a code coming from a stale build / persisted job payload.
    const error = new AppError("SOMETHING_WE_DELETED" as ErrorCode);

    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("Unexpected internal error");
    expect(error.userMessage).toBe("Hệ thống gặp sự cố. Vui lòng thử lại sau ít phút.");
  });

  it("keeps context empty instead of undefined when none is given", () => {
    expect(new AppError("INTERNAL").context).toEqual({});
  });

  it("recognises a foreign AppError instance via the _tag brand", () => {
    // Duplicated module instances (Next server/client graphs) break instanceof.
    const foreign = { _tag: "AppError", code: "UNAUTHORIZED", userMessage: "x" };

    expect(AppError.is(foreign)).toBe(true);
    expect(AppError.is({ _tag: "AppError", code: "NOPE" })).toBe(false);
    expect(AppError.is(new Error("plain"))).toBe(false);
    expect(AppError.is(null)).toBe(false);
    expect(AppError.is("OUT_OF_STOCK")).toBe(false);
  });

  it("wraps a non-Error throwable without losing the original value", () => {
    const wrapped = AppError.from("boom");

    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.cause).toBe("boom");
  });

  it("wraps an Error and keeps it as cause", () => {
    const cause = new Error("socket hang up");
    const wrapped = AppError.from(cause, "INTERNAL", { route: "GET /api/health" });

    expect(wrapped.cause).toBe(cause);
    expect(wrapped.context).toEqual({ route: "GET /api/health" });
  });

  it("returns the same AppError when re-wrapped without extra context", () => {
    const original = new AppError("UNAUTHORIZED");

    expect(AppError.from(original)).toBe(original);
  });

  it("merges extra context when re-wrapping an AppError", () => {
    const original = new AppError("TENANT_NOT_FOUND", { context: { tenant_id: "t1" } });
    const rewrapped = AppError.from(original, "INTERNAL", { job_id: "j9" });

    expect(rewrapped.code).toBe("TENANT_NOT_FOUND");
    expect(rewrapped.context).toEqual({ tenant_id: "t1", job_id: "j9" });
    expect(rewrapped.userMessage).toBe(original.userMessage);
  });

  it("isErrorCode rejects non-string and unknown values", () => {
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode("INVALID_INPUT")).toBe(true);
  });
});

describe("AppError — happy path", () => {
  it("uses the explicit messages when provided", () => {
    const error = new AppError("INVALID_INPUT", {
      message: "colour code missing",
      userMessage: "Thiếu mã màu.",
      context: { product_code: "AB123" },
    });

    expect(error.name).toBe("AppError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("colour code missing");
    expect(error.userMessage).toBe("Thiếu mã màu.");
    expect(error.context).toEqual({ product_code: "AB123" });
  });

  it("exposes a serialisable log object with stack and cause", () => {
    const cause = new Error("driver timeout");
    const logged = new AppError("INTERNAL", { context: { job_id: "j1" }, cause }).toLogObject();

    expect(logged.code).toBe("INTERNAL");
    expect(logged.context).toEqual({ job_id: "j1" });
    expect(logged.stack).toContain("AppError");
    expect(logged.cause).toContain("driver timeout");
    expect(() => JSON.stringify(logged)).not.toThrow();
  });

  it("gives every registered code both an EN and a VI message", () => {
    for (const code of ERROR_CODES) {
      const error = new AppError(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.userMessage.length).toBeGreaterThan(0);
      expect(error.message).not.toBe(error.userMessage);
    }
  });
});
