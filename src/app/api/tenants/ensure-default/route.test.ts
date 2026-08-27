import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * E10 — the boundary contract of `POST /api/tenants/ensure-default`: the first
 * screen calls it blind, so it must be safe to call on every entry. Deliberately
 * NO tenant context — there is nothing to be a member of yet.
 */

const ensureDefaultTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { ensureDefaultTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = "00000000-0000-0000-0000-00000000c0de";

function request(): Request {
  return new Request("http://localhost/api/tenants/ensure-default", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({
    email: "founder@x.vn",
    name: "Founder",
    accountId: "acc-1",
  });
  ensureDefaultTenant.mockResolvedValue({ tenantId: TENANT, wasCreated: true });
});

// --- Refusals first -----------------------------------------------------------

describe("POST /api/tenants/ensure-default — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(ensureDefaultTenant).not.toHaveBeenCalled();
  });

  it("401s a bootstrap session with NO account row — consistent with M1.3b", async () => {
    getOperatorSession.mockResolvedValue({
      email: "boss@mysp.vn",
      accountId: null,
      isBootstrapAdmin: true,
    });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(ensureDefaultTenant).not.toHaveBeenCalled();
  });

  it("409s TENANT_LIMIT_REACHED with the shared error shape and no cookie", async () => {
    ensureDefaultTenant.mockRejectedValue(new AppError("TENANT_LIMIT_REACHED"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_LIMIT_REACHED" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not leak an unexpected failure as a success", async () => {
    ensureDefaultTenant.mockRejectedValue(new Error("connection reset"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

// --- Happy paths --------------------------------------------------------------

describe("POST /api/tenants/ensure-default — provisioning", () => {
  it("201s and switches the active-tenant cookie when it created one", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ tenantId: TENANT, wasCreated: true });
    expect(response.headers.get("set-cookie")).toContain(`${ACTIVE_TENANT_COOKIE}=${TENANT}`);
    expect(ensureDefaultTenant).toHaveBeenCalledWith({
      accountId: "acc-1",
      sessionEmail: "founder@x.vn",
      displayName: "Founder",
    });
  });

  it("200s and leaves the cookie ALONE when the account already had a company", async () => {
    // Re-entering must not silently re-select a company for someone who picked
    // one; /api/me stays the source of truth for the active tenant.
    ensureDefaultTenant.mockResolvedValue({ tenantId: TENANT, wasCreated: false });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: TENANT, wasCreated: false });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("carries a missing display name through as null", async () => {
    getOperatorSession.mockResolvedValue({ email: "founder@x.vn", accountId: "acc-1" });

    await POST(request());

    expect(ensureDefaultTenant).toHaveBeenCalledWith({
      accountId: "acc-1",
      sessionEmail: "founder@x.vn",
      displayName: null,
    });
  });
});
