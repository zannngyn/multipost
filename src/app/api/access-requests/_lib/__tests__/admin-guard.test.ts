import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1.3b — the two doors of the access screen: env bootstrap admins keep their
 * database-free path (they may have NO account row, and the screen must work
 * precisely when the database is the thing being repaired); everyone else goes
 * through membership + minRole admin.
 */

const requireTenant = vi.fn();
const getOperatorSession = vi.fn();
const readActiveTenantCookie = vi.fn(() => null);

const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

vi.mock("@/composition/container", () => ({
  ACCESS_REGISTRY_TENANT_ID: DEMO_TENANT,
  getContainer: () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    usecases: { requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

vi.mock("@/app/_lib/active-tenant-cookie", () => ({
  readActiveTenantCookie: () => readActiveTenantCookie(),
}));

const { requireAccessAdmin } = await import("../admin-guard");

const request = () => new Request("http://localhost/api/access-requests");

beforeEach(() => {
  vi.clearAllMocks();
  requireTenant.mockResolvedValue({ tenantId: OTHER_TENANT, role: "admin", membershipVersion: 1 });
});

// --- Edge cases first ---------------------------------------------------------

describe("requireAccessAdmin — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    await expect(
      requireAccessAdmin(request(), { route: "GET /api/access-requests", tier: "R" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
  });

  it("lets a FORBIDDEN from the membership check surface (editor is not enough)", async () => {
    getOperatorSession.mockResolvedValue({
      email: "editor@x.vn",
      isBootstrapAdmin: false,
      accountId: "acc-1",
    });
    const { AppError } = await import("@/core/domain/errors");
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    await expect(
      requireAccessAdmin(request(), { route: "POST /api/access-requests/decide", tier: "S" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("requireAccessAdmin — the two doors", () => {
  it("bootstrap admin: registry tenant, NO database authorisation on the path", async () => {
    // The escape hatch may hold no account row at all — requireTenant would
    // 401 exactly the person this screen exists for. Env is their authority.
    getOperatorSession.mockResolvedValue({
      email: "boss@mysp.vn",
      isBootstrapAdmin: true,
      accountId: null,
    });

    const result = await requireAccessAdmin(request(), {
      route: "GET /api/access-requests",
      tier: "R",
    });

    expect(result.tenantId).toBe(DEMO_TENANT);
    expect(requireTenant).not.toHaveBeenCalled();
  });

  it("ordinary admin: tenant from the membership, at the caller's tier", async () => {
    getOperatorSession.mockResolvedValue({
      email: "admin@x.vn",
      isBootstrapAdmin: false,
      accountId: "acc-1",
    });

    const result = await requireAccessAdmin(request(), {
      route: "POST /api/access-requests/decide",
      tier: "S",
    });

    expect(result.tenantId).toBe(OTHER_TENANT);
    expect(requireTenant).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1" }),
      null,
      // supportSessionId travels since M3.3 (null without a support cookie).
      { tier: "S", minRole: "admin", supportSessionId: null },
    );
  });
});
