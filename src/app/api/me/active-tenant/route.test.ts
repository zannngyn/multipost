import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.2 — the boundary contract of `POST /api/me/active-tenant`: the cookie is
 * written ONLY after the fresh membership check passes, and every refusal is
 * the same 404 so the endpoint cannot probe which tenants exist.
 */

const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function request(body: unknown): Request {
  return new Request("http://localhost/api/me/active-tenant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "worker@gmail.com", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "editor", membershipVersion: 1 });
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/me/active-tenant — refusals", () => {
  it("401s without a session, before reading the body", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await POST(request({ tenantId: TENANT }));

    expect(response.status).toBe(401);
    expect(requireTenant).not.toHaveBeenCalled();
  });

  it("400s a body without a UUID tenant id — and sets no cookie", async () => {
    const response = await POST(request({ tenantId: testTenantId("demo") }));

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(requireTenant).not.toHaveBeenCalled();
  });

  it("404s a tenant the account has no membership in — and sets no cookie", async () => {
    const { AppError } = await import("@/core/domain/errors");
    requireTenant.mockRejectedValue(new AppError("TENANT_NOT_FOUND"));

    const response = await POST(request({ tenantId: TENANT }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/me/active-tenant — the switch", () => {
  it("answers the new active tenant and writes the selector cookie", async () => {
    const response = await POST(request({ tenantId: TENANT }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ activeTenantId: TENANT });

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${ACTIVE_TENANT_COOKIE}=${TENANT}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // Dev box runs plain http; Secure only in production.
    expect(cookie).not.toContain("Secure");

    // The body's tenantId is the SELECTOR handed to the authoriser (tier S,
    // fresh membership read) — no separate usecase, no second check.
    expect(requireTenant).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1" }),
      TENANT,
      { tier: "S" },
    );
  });
});
