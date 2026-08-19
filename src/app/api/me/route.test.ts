import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1.2 — the boundary contract of `GET /api/me`: it serves EVERY signed-in
 * state (member, NoMembership, bootstrap-without-account) and refuses only the
 * sessionless; the cookie goes in as raw material for validation, never as an
 * answer.
 */

const getOperatorOverview = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getOperatorOverview },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";

function request(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request("http://localhost/api/me", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "worker@gmail.com", accountId: "acc-1" });
  getOperatorOverview.mockResolvedValue({
    account: { id: "acc-1", displayName: "Worker", platformRole: null },
    tenants: [{ id: TENANT, name: "Demo", slug: "demo", plan: "internal", role: "editor" }],
    activeTenantId: TENANT,
  });
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/me — refusals", () => {
  it("401s without a session, and never calls the usecase", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getOperatorOverview).not.toHaveBeenCalled();
  });

  it("maps a usecase failure through the shared error shape", async () => {
    const { AppError } = await import("@/core/domain/errors");
    getOperatorOverview.mockRejectedValue(new AppError("DB_ERROR"));

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "DB_ERROR" });
  });
});

describe("GET /api/me — answers", () => {
  it("returns the overview for a member", async () => {
    const response = await GET(request(`${ACTIVE_TENANT_COOKIE}=${TENANT}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: { id: "acc-1" },
      activeTenantId: TENANT,
    });
    expect(getOperatorOverview).toHaveBeenCalledWith({
      sessionEmail: "worker@gmail.com",
      cookieTenantId: TENANT,
    });
  });

  it("hands a MALFORMED cookie to the usecase as null, not as a value", async () => {
    await GET(request(`${ACTIVE_TENANT_COOKIE}=not-a-uuid`));

    expect(getOperatorOverview).toHaveBeenCalledWith({
      sessionEmail: "worker@gmail.com",
      cookieTenantId: null,
    });
  });

  it("stays 200 for a NoMembership answer — the UI needs it to draw the picker", async () => {
    getOperatorOverview.mockResolvedValue({ account: null, tenants: [], activeTenantId: null });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account: null,
      tenants: [],
      activeTenantId: null,
    });
  });
});
