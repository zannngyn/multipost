import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Tenant } from "@/core/domain/tenant";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";
import type { TenantRepo } from "@/core/ports/tenant-repo";

import { makeHealthcheckTenant, type HealthcheckTenantInput } from "./healthcheck-tenant";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const DEMO_ID = testTenantId("00000000-0000-0000-0000-000000000001");
const FROZEN_AT = new Date("2026-08-12T03:04:05.000Z");

function fakeClock(at: Date = FROZEN_AT): Clock {
  return { now: () => at, nowMs: () => at.getTime() };
}

/** Records every line so tests can assert tenant_id binding + error codes. */
function fakeLogger(bindings: LogBindings = {}) {
  const lines: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  const make = (own: LogBindings): Logger => ({
    child: (extra) => make({ ...own, ...extra }),
    debug: (message, context) => lines.push({ level: "debug", message, context: { ...own, ...context } }),
    info: (message, context) => lines.push({ level: "info", message, context: { ...own, ...context } }),
    warn: (message, context) => lines.push({ level: "warn", message, context: { ...own, ...context } }),
    error: (message, context) => lines.push({ level: "error", message, context: { ...own, ...context } }),
  });
  return { logger: make(bindings), lines };
}

function fakeRepo(impl: TenantRepo["findById"]): TenantRepo {
  return { findById: vi.fn(impl) };
}

const activeTenant: Tenant = { id: DEMO_ID, name: "Demo Tenant", status: "active" };

describe("healthcheckTenant — edge cases", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a uuid", "tenant-1"],
    ["truncated uuid", "0000-0000-0001"],
    ["uuid with extra chars", `${DEMO_ID}x`],
  ])("rejects %s with INVALID_INPUT before touching the repo", async (_label, tenantId) => {
    const repo = fakeRepo(async () => activeTenant);
    const { logger, lines } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    await expect(healthcheckTenant({ tenantId: testTenantId(tenantId) })).rejects.toMatchObject({
      _tag: "AppError",
      code: "INVALID_INPUT",
    });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(lines.at(-1)?.context.error_code).toBe("INVALID_INPUT");
  });

  it("rejects a missing/undefined tenantId instead of throwing TypeError", async () => {
    const repo = fakeRepo(async () => activeTenant);
    const { logger } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    // Simulates an unvalidated payload arriving from a job/route.
    const error = await healthcheckTenant({} as HealthcheckTenantInput).catch((e: unknown) => e);

    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect((error as AppError).context).toEqual({ tenant_id: null });
  });

  it("throws TENANT_NOT_FOUND with tenant_id context when the repo returns null", async () => {
    const repo = fakeRepo(async () => null);
    const { logger, lines } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    const error = await healthcheckTenant({ tenantId: DEMO_ID }).catch((e: unknown) => e);

    expect((error as AppError).code).toBe("TENANT_NOT_FOUND");
    expect((error as AppError).context).toEqual({ tenant_id: DEMO_ID });
    expect(lines.at(-1)).toMatchObject({
      level: "warn",
      context: { tenant_id: DEMO_ID, error_code: "TENANT_NOT_FOUND" },
    });
  });

  it("propagates the adapter's DB_ERROR unchanged (no swallowing, no re-wrapping)", async () => {
    const dbError = new AppError("DB_ERROR", { context: { tenant_id: DEMO_ID } });
    const repo = fakeRepo(async () => {
      throw dbError;
    });
    const { logger } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    await expect(healthcheckTenant({ tenantId: DEMO_ID })).rejects.toBe(dbError);
  });

  it("still reports a suspended tenant — status is data, not a failure", async () => {
    const repo = fakeRepo(async () => ({ ...activeTenant, status: "suspended" }) as const);
    const { logger } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    await expect(healthcheckTenant({ tenantId: DEMO_ID })).resolves.toMatchObject({
      status: "suspended",
    });
  });
});

describe("healthcheckTenant — happy path", () => {
  it("returns the tenant plus checkedAt taken from the injected Clock", async () => {
    const repo = fakeRepo(async () => activeTenant);
    const { logger, lines } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    await expect(healthcheckTenant({ tenantId: testTenantId(` ${DEMO_ID} `) })).resolves.toEqual({
      tenantId: DEMO_ID,
      name: "Demo Tenant",
      status: "active",
      checkedAt: "2026-08-12T03:04:05.000Z",
    });
    // Trimmed id must reach the repo, not the padded input.
    expect(repo.findById).toHaveBeenCalledWith(DEMO_ID);
    expect(lines.at(-1)).toMatchObject({ level: "info", context: { tenant_id: DEMO_ID } });
  });

  it("accepts an upper-case uuid without mangling it", async () => {
    const upper = testTenantId(DEMO_ID.toUpperCase());
    const repo = fakeRepo(async () => ({ ...activeTenant, id: upper }));
    const { logger } = fakeLogger();
    const healthcheckTenant = makeHealthcheckTenant({ tenants: repo, clock: fakeClock(), logger });

    await expect(healthcheckTenant({ tenantId: upper })).resolves.toMatchObject({
      tenantId: upper,
    });
  });
});
