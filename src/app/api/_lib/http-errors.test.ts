import { describe, expect, it, vi } from "vitest";

import { AppError, type ErrorCode } from "@/core/domain/errors";

import { httpStatusForCode, jsonError, mapAppErrorToHttp, type ApiErrorBody } from "./http-errors";

const readBody = async (response: Response): Promise<ApiErrorBody> =>
  (await response.json()) as ApiErrorBody;

const makeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("mapAppErrorToHttp — edge cases", () => {
  it("maps a plain Error to 500 INTERNAL without leaking details", async () => {
    const response = mapAppErrorToHttp(new Error("connect ECONNREFUSED 10.0.0.4:5432"));
    const body = await readBody(response);

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(body.message).toBe("Hệ thống gặp sự cố. Vui lòng thử lại sau ít phút.");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
  });

  it("maps a non-Error throwable (string) to 500 INTERNAL", async () => {
    const response = mapAppErrorToHttp("kaboom");

    expect(response.status).toBe(500);
    expect((await readBody(response)).code).toBe("INTERNAL");
  });

  it("maps undefined to 500 INTERNAL instead of throwing", async () => {
    const response = mapAppErrorToHttp(undefined);

    expect(response.status).toBe(500);
    expect((await readBody(response)).code).toBe("INTERNAL");
  });

  it("falls back to 500 for a code missing from the status table", () => {
    expect(httpStatusForCode("NOT_A_REAL_CODE" as ErrorCode)).toBe(500);
  });

  it("omits issues when the context is malformed", async () => {
    const error = new AppError("INVALID_INPUT", { context: { issues: "not-an-array" } });
    const body = await readBody(mapAppErrorToHttp(error));

    expect(body.issues).toBeUndefined();
  });

  it("drops issue entries that have no string message", async () => {
    const error = new AppError("INVALID_INPUT", {
      context: { issues: [{ path: "code" }, { path: 7, message: "Bắt buộc" }] },
    });
    const body = await readBody(mapAppErrorToHttp(error));

    expect(body.issues).toEqual([{ path: "", message: "Bắt buộc" }]);
  });

  it("never attaches issues to a non-INVALID_INPUT error", async () => {
    const error = new AppError("UNAUTHORIZED", {
      context: { issues: [{ path: "token", message: "hết hạn" }] },
    });

    expect((await readBody(mapAppErrorToHttp(error))).issues).toBeUndefined();
  });

  it("does not throw when no logger is supplied", () => {
    expect(() => mapAppErrorToHttp(new AppError("INTERNAL"))).not.toThrow();
  });
});

describe("mapAppErrorToHttp — logging", () => {
  it("logs 5xx with the error attached so the stack reaches the log sink", () => {
    const logger = makeLogger();
    const error = new AppError("INTERNAL", { context: { job_id: "j1" } });

    mapAppErrorToHttp(error, { logger, context: { route: "POST /api/posts" } });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, payload] = logger.error.mock.calls[0];
    expect(message).toBe("Request failed with server error");
    expect(payload).toMatchObject({ route: "POST /api/posts", code: "INTERNAL", status: 500 });
    expect(payload.err).toBe(error);
  });

  it("logs 4xx as a warning, not an error — the caller is at fault, not the server", () => {
    const logger = makeLogger();

    mapAppErrorToHttp(new AppError("INVALID_INPUT"), { logger, context: { tenant_id: "t1" } });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, payload] = logger.warn.mock.calls[0];
    expect(message).toBe("Request failed with client error");
    expect(payload).toMatchObject({ tenant_id: "t1", status: 400 });
    expect(payload.err).toBeUndefined();
  });

  it("keeps 5xx on the error channel even when it carries a business code", () => {
    const logger = makeLogger();

    mapAppErrorToHttp(new AppError("DB_ERROR"), { logger, context: { tenant_id: "t1" } });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ status: 503, code: "DB_ERROR" });
  });

  it("logs unknown throwables too — nothing is swallowed", () => {
    const logger = makeLogger();

    mapAppErrorToHttp("kaboom", { logger, context: { route: "GET /api/health" } });

    expect(logger.error).toHaveBeenCalledWith(
      "Unhandled error in route handler",
      expect.objectContaining({ route: "GET /api/health", status: 500 }),
    );
  });
});

describe("mapAppErrorToHttp — happy path", () => {
  it.each([
    ["INVALID_INPUT", 400],
    ["UNAUTHORIZED", 401],
    ["TENANT_NOT_FOUND", 404],
    ["INTERNAL", 500],
    ["DB_ERROR", 503],
    ["QUEUE_ERROR", 503],
    ["JOB_PAYLOAD_INVALID", 400],
  ] as const)("maps %s to HTTP %i", async (code, status) => {
    const response = mapAppErrorToHttp(new AppError(code));
    const body = await readBody(response);

    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(body.message).toBe(new AppError(code).userMessage);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns zod-style issues for INVALID_INPUT", async () => {
    const error = new AppError("INVALID_INPUT", {
      context: { issues: [{ path: "channels", message: "Chọn ít nhất một kênh" }] },
    });
    const body = await readBody(mapAppErrorToHttp(error));

    expect(body.issues).toEqual([{ path: "channels", message: "Chọn ít nhất một kênh" }]);
  });
});

describe("jsonError", () => {
  it("omits the issues key when the list is empty", async () => {
    const body = await readBody(jsonError(400, "INVALID_INPUT", "Sai dữ liệu", []));

    expect(body).toEqual({ code: "INVALID_INPUT", message: "Sai dữ liệu" });
  });
});
