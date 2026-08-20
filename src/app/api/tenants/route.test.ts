import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M2.1 — the boundary contract of `POST /api/tenants`: any account-backed
 * session may found a company; the cookie switches only on success; every
 * refusal keeps the shared error shape.
 */

const createTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { createTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const NEW_TENANT = "00000000-0000-0000-0000-00000000c0de";

function request(body: unknown): Request {
  return new Request("http://localhost/api/tenants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({
    email: "founder@x.vn",
    name: "Founder",
    accountId: "acc-1",
  });
  createTenant.mockResolvedValue({
    tenant: { id: NEW_TENANT, name: "Công ty X", slug: "cong-ty-x", plan: "standard", role: "owner" },
    activeTenantId: NEW_TENANT,
  });
});

// --- Refusals first -----------------------------------------------------------

describe("POST /api/tenants — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await POST(request({ name: "Công ty X" }));
    expect(response.status).toBe(401);
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("401s a bootstrap session with NO account row — consistent with M1.3b", async () => {
    getOperatorSession.mockResolvedValue({
      email: "boss@mysp.vn",
      accountId: null,
      isBootstrapAdmin: true,
    });
    const response = await POST(request({ name: "Công ty X" }));
    expect(response.status).toBe(401);
  });

  it("400s a too-short name before the usecase runs", async () => {
    const response = await POST(request({ name: "A" }));
    expect(response.status).toBe(400);
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("409s SLUG_TAKEN and sets no cookie", async () => {
    createTenant.mockRejectedValue(new AppError("SLUG_TAKEN"));
    const response = await POST(request({ name: "Công ty X", slug: "cong-ty-x" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "SLUG_TAKEN" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("409s TENANT_LIMIT_REACHED with the Vietnamese limit message", async () => {
    createTenant.mockRejectedValue(new AppError("TENANT_LIMIT_REACHED"));
    const response = await POST(request({ name: "Công ty X" }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("TENANT_LIMIT_REACHED");
    expect(body.message).toContain("giới hạn");
  });
});

// --- Happy path ---------------------------------------------------------------

describe("POST /api/tenants — creation", () => {
  it("201s, hands the actor from the session, and switches the active tenant", async () => {
    const response = await POST(request({ name: "Công ty X" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // `tenant.id` — the field ui-web reads, identical to /api/me tenants[].id.
      tenant: { id: NEW_TENANT, role: "owner", slug: "cong-ty-x" },
      activeTenantId: NEW_TENANT,
    });
    expect(createTenant).toHaveBeenCalledWith({
      accountId: "acc-1",
      sessionEmail: "founder@x.vn",
      displayName: "Founder",
      name: "Công ty X",
      slug: null,
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${ACTIVE_TENANT_COOKIE}=${NEW_TENANT}`);
  });
});
