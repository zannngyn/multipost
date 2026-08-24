import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * First-run — boundary contract of `GET /api/tenants/setup-progress`: the claim
 * it makes (tier R, admin), and that a refusal never reaches the usecase.
 *
 * `minRole: "admin"` is the interesting one. Every step behind this list is an
 * admin action (connect Google, choose a sheet, connect a Fanpage), so an
 * editor asking would get a list of things they cannot do — the dock is not
 * rendered for them, and the route agrees.
 */

const getSetupProgress = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getSetupProgress, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");

const TENANT = "00000000-0000-0000-0000-000000000001";

const request = () => new Request("http://localhost/api/tenants/setup-progress");

const PROGRESS = {
  tenantId: TENANT,
  steps: [
    { id: "tenant", isDone: true },
    { id: "google", isDone: true },
    { id: "source", isDone: false },
    { id: "facebook", isDone: false },
    { id: "group", isDone: false },
    { id: "firstPost", isDone: false },
  ],
  doneCount: 2,
  requiredCount: 5,
  isReady: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@x.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  getSetupProgress.mockResolvedValue(PROGRESS);
});

// --- Refusals first ---------------------------------------------------------

describe("GET /api/tenants/setup-progress — refusals", () => {
  it("401s without a session and never reaches the usecase", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(getSetupProgress).not.toHaveBeenCalled();
  });

  it("403s an editor — every step on this list is an admin action", async () => {
    requireTenant.mockRejectedValue(
      new AppError("FORBIDDEN", { context: { tenant_id: TENANT, role: "editor" } }),
    );
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(getSetupProgress).not.toHaveBeenCalled();
  });

  it("409s when no company is selected", async () => {
    requireTenant.mockRejectedValue(new AppError("TENANT_NOT_SELECTED"));
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(getSetupProgress).not.toHaveBeenCalled();
  });

  it("keeps the shared error shape when the usecase itself fails", async () => {
    getSetupProgress.mockRejectedValue(new AppError("DB_ERROR", { context: { tenant_id: TENANT } }));
    const response = await GET(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("DB_ERROR");
    expect(typeof body.message).toBe("string");
  });
});

// --- The claim --------------------------------------------------------------

describe("GET /api/tenants/setup-progress — authorisation claim", () => {
  it("asks for tier R and a minimum role of admin", async () => {
    await GET(request());
    // Positional assert rather than toHaveBeenCalledWith: the second argument
    // is the active-tenant cookie, which is legitimately null on a request that
    // carries none — and `expect.anything()` refuses null.
    const claim = requireTenant.mock.calls[0]?.[2] as { tier?: string; minRole?: string };
    expect(claim).toMatchObject({ tier: "R", minRole: "admin" });
  });

  it("takes the tenant from the authorised context, never from the request", async () => {
    await GET(request());
    expect(getSetupProgress).toHaveBeenCalledWith({ tenantId: TENANT });
  });
});

// --- Happy path -------------------------------------------------------------

describe("GET /api/tenants/setup-progress — happy path", () => {
  it("returns the usecase answer unchanged", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(PROGRESS);
  });
});
