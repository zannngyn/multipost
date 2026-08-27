import { describe, expect, it, vi } from "vitest";

import type { Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import {
  HEALTHCHECK_TENANT_JOB_NAME,
  makeHealthcheckTenantHandler,
  parseHealthcheckTenantPayload,
} from "../healthcheck-tenant-job";

/** Edge cases first (CLAUDE.md #1): every way this job can go wrong. */

const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function fakeLogger() {
  const logger = {
    child: vi.fn(() => logger as unknown as Logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function envelope(payload: unknown, attempt = 1) {
  return {
    jobId: "job-1",
    jobName: HEALTHCHECK_TENANT_JOB_NAME,
    payload,
    attempt,
    maxAttempts: 3,
  };
}

describe("parseHealthcheckTenantPayload — invalid input", () => {
  const invalidCases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a string instead of an object", DEMO_TENANT_ID],
    ["an array", []],
    ["an empty object", {}],
    ["an empty tenantId", { tenantId: "" }],
    ["a whitespace-only tenantId", { tenantId: "   " }],
    ["a non-string tenantId", { tenantId: 42 }],
    ["a null tenantId", { tenantId: null }],
    ["an unknown extra key", { tenantId: DEMO_TENANT_ID, channel: "fb" }],
  ];

  it.each(invalidCases)("rejects %s with JOB_PAYLOAD_INVALID", (_label, raw) => {
    try {
      parseHealthcheckTenantPayload(raw, { job_id: "job-1" });
      throw new Error("expected parseHealthcheckTenantPayload to throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.code).toBe("JOB_PAYLOAD_INVALID");
      expect(appError.userMessage).toMatch(/không hợp lệ/i);
      expect(appError.context).toMatchObject({
        job_id: "job-1",
        job_name: HEALTHCHECK_TENANT_JOB_NAME,
      });
      expect(Array.isArray((appError.context as { issues?: unknown }).issues)).toBe(true);
    }
  });
});

describe("parseHealthcheckTenantPayload — valid input", () => {
  it("trims the tenant id and keeps the shape", () => {
    expect(parseHealthcheckTenantPayload({ tenantId: `  ${DEMO_TENANT_ID}  ` })).toEqual({
      tenantId: DEMO_TENANT_ID,
    });
  });

  it("accepts a syntactically wrong id — the usecase owns the UUID rule", () => {
    expect(parseHealthcheckTenantPayload({ tenantId: "not-a-uuid" })).toEqual({
      tenantId: "not-a-uuid",
    });
  });
});

describe("makeHealthcheckTenantHandler — failure branches", () => {
  it("rejects a bad payload before calling the usecase", async () => {
    const healthcheckTenant = vi.fn();
    const logger = fakeLogger();
    const handler = makeHealthcheckTenantHandler({
      logger: logger as unknown as Logger,
      healthcheckTenant: healthcheckTenant as unknown as Usecases["healthcheckTenant"],
    });

    await expect(handler(envelope({ tenantId: "" }))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
    });
    expect(healthcheckTenant).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([
    ["TENANT_NOT_FOUND", "TENANT_NOT_FOUND"],
    ["INVALID_INPUT", "INVALID_INPUT"],
    ["DB_ERROR", "DB_ERROR"],
  ] as const)("rethrows %s from the usecase, keeping the code", async (_label, code) => {
    const logger = fakeLogger();
    const healthcheckTenant = vi.fn(async () => {
      throw new AppError(code, { context: { tenant_id: DEMO_TENANT_ID } });
    });
    const handler = makeHealthcheckTenantHandler({
      logger: logger as unknown as Logger,
      healthcheckTenant: healthcheckTenant as unknown as Usecases["healthcheckTenant"],
    });

    await expect(handler(envelope({ tenantId: DEMO_TENANT_ID }))).rejects.toMatchObject({ code });
    expect(logger.error).toHaveBeenCalledWith(
      "healthcheck-tenant job failed",
      expect.objectContaining({ error_code: code }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("wraps a non-AppError failure as INTERNAL with job context", async () => {
    const logger = fakeLogger();
    const healthcheckTenant = vi.fn(async () => {
      throw new TypeError("socket exploded");
    });
    const handler = makeHealthcheckTenantHandler({
      logger: logger as unknown as Logger,
      healthcheckTenant: healthcheckTenant as unknown as Usecases["healthcheckTenant"],
    });

    await expect(handler(envelope({ tenantId: DEMO_TENANT_ID }, 2))).rejects.toMatchObject({
      code: "INTERNAL",
      context: { job_id: "job-1", tenant_id: DEMO_TENANT_ID, attempt: 2 },
    });
  });
});

describe("makeHealthcheckTenantHandler — happy path", () => {
  it("calls the usecase with the trimmed id and logs the result", async () => {
    const logger = fakeLogger();
    const healthcheckTenant = vi.fn(async () => ({
      tenantId: DEMO_TENANT_ID,
      name: "Demo Tenant",
      status: "active" as const,
      checkedAt: "2026-08-13T00:00:00.000Z",
    }));
    const handler = makeHealthcheckTenantHandler({
      logger: logger as unknown as Logger,
      healthcheckTenant: healthcheckTenant as unknown as Usecases["healthcheckTenant"],
    });

    await expect(
      handler(envelope({ tenantId: `  ${DEMO_TENANT_ID}  ` })),
    ).resolves.toBeUndefined();

    expect(healthcheckTenant).toHaveBeenCalledWith({ tenantId: DEMO_TENANT_ID });
    expect(logger.child).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: "job-1",
        job_name: HEALTHCHECK_TENANT_JOB_NAME,
        tenant_id: DEMO_TENANT_ID,
      }),
    );
    // tenant_id stays on the child bindings only — no duplicate key in the line.
    expect(logger.info).toHaveBeenCalledWith("healthcheck-tenant job done", {
      tenant_name: "Demo Tenant",
      status: "active",
      checked_at: "2026-08-13T00:00:00.000Z",
    });
  });
});
