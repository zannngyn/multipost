import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.2 — the boundary contract of `GET /api/me`: it serves EVERY signed-in
 * state (member, NoMembership, bootstrap-without-account) and refuses only the
 * sessionless; the cookie goes in as raw material for validation, never as an
 * answer.
 */

const getOperatorOverview = vi.fn();
const peekSupport = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getOperatorOverview, supportSessions: { peek: peekSupport } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function request(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request("http://localhost/api/me", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({
    email: "worker@gmail.com",
    accountId: "acc-1",
    isBootstrapAdmin: false,
  });
  peekSupport.mockResolvedValue(null);
  getOperatorOverview.mockResolvedValue({
    isBootstrapAdmin: false,
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
      isBootstrapAdmin: false,
      cookieTenantId: TENANT,
    });
  });

  it("hands the SESSION's bootstrap flag to the usecase — N6, the UI's only tell", async () => {
    getOperatorSession.mockResolvedValue({
      email: "boss@mysp.vn",
      accountId: null,
      isBootstrapAdmin: true,
    });
    getOperatorOverview.mockResolvedValue({
      isBootstrapAdmin: true,
      account: null,
      tenants: [],
      activeTenantId: null,
    });

    const response = await GET(request());

    expect(getOperatorOverview).toHaveBeenCalledWith(
      expect.objectContaining({ isBootstrapAdmin: true }),
    );
    await expect(response.json()).resolves.toMatchObject({
      isBootstrapAdmin: true,
      account: null,
      tenants: [],
    });
  });

  it("hands a MALFORMED cookie to the usecase as null, not as a value", async () => {
    await GET(request(`${ACTIVE_TENANT_COOKIE}=not-a-uuid`));

    expect(getOperatorOverview).toHaveBeenCalledWith({
      sessionEmail: "worker@gmail.com",
      isBootstrapAdmin: false,
      cookieTenantId: null,
    });
  });

  it("M3.3: a live support visit rides on top — banner data + activeTenantId override", async () => {
    const { SUPPORT_SESSION_COOKIE } = await import("@/app/_lib/support-session-cookie");
    const VISITED = "00000000-0000-0000-0000-00000000d00d";
    peekSupport.mockResolvedValue({
      sessionId: "99999999-8888-7777-6666-555555555555",
      tenantId: VISITED,
      tenantName: "Khách A",
      tenantSlug: "khach-a",
      expiresAt: new Date("2026-08-22T07:00:00.000Z"),
    });

    const response = await GET(
      request(`${SUPPORT_SESSION_COOKIE}=99999999-8888-7777-6666-555555555555`),
    );

    const body = await response.json();
    expect(body.supportSession).toEqual({
      tenantId: VISITED,
      tenantName: "Khách A",
      expiresAt: "2026-08-22T07:00:00.000Z",
    });
    // The visited tenant becomes the active one so the R routes read its data.
    expect(body.activeTenantId).toBe(VISITED);
    expect(peekSupport).toHaveBeenCalledWith(
      "99999999-8888-7777-6666-555555555555",
      "acc-1",
    );
  });

  it("answers supportSession: null when no visit is live — the overview stands", async () => {
    const response = await GET(request());
    const body = await response.json();
    expect(body.supportSession).toBeNull();
    expect(body.activeTenantId).toBe(TENANT); // untouched
  });

  it("stays 200 for a NoMembership answer — the UI needs it to draw the picker", async () => {
    getOperatorOverview.mockResolvedValue({
      isBootstrapAdmin: false,
      account: null,
      tenants: [],
      activeTenantId: null,
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      isBootstrapAdmin: false,
      account: null,
      tenants: [],
      activeTenantId: null,
      supportSession: null, // M3.3: present on every answer
    });
  });
});
