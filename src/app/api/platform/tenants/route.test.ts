import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M3.2 — boundary contract of /api/platform/tenants: support may LIST (the
 * deliberate matrix deviation), only super_admin may CREATE, and the
 * owner-invite token appears exactly once, as a /join URL.
 */

const listTenants = vi.fn();
const createTenant = vi.fn();
const requirePlatformAdmin = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { platformTenants: { listTenants, createTenant }, requirePlatformAdmin },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

// Canonical origin ≠ request host on purpose: the assertion below pins that
// the invite URL follows AUTH_URL, never the incoming request.
vi.stubEnv("AUTH_URL", "https://mysp.example");

const { GET, POST } = await import("./route");

const TENANT = "00000000-0000-0000-0000-00000000d00d";
const TOKEN = "p".repeat(64);

const getRequest = () => new Request("http://localhost/api/platform/tenants");
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/platform/tenants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "root@mysp.vn", accountId: "acc-root" });
  requirePlatformAdmin.mockResolvedValue({ accountId: "acc-root", platformRole: "super_admin" });
  listTenants.mockResolvedValue([
    {
      id: TENANT,
      name: "Khách A",
      slug: "khach-a",
      plan: "standard",
      status: "active",
      memberCount: 3,
      createdAt: new Date("2026-08-21T05:00:00Z"),
    },
  ]);
  createTenant.mockResolvedValue({
    tenant: { id: TENANT, name: "Khách A", slug: "khach-a", plan: "standard", status: "active" },
    ownerInviteToken: TOKEN,
    inviteExpiresAt: new Date("2026-08-28T05:00:00Z"),
  });
});

// --- Refusals first -----------------------------------------------------------

describe("/api/platform/tenants — refusals", () => {
  it("403s an ordinary operator on GET — no platform role, no list", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("demands only SUPPORT for the list, but SUPER_ADMIN for creation", async () => {
    await GET(getRequest());
    expect(requirePlatformAdmin).toHaveBeenLastCalledWith(expect.anything(), {
      minRole: "support",
    });

    await POST(postRequest({ name: "Khách A" }));
    expect(requirePlatformAdmin).toHaveBeenLastCalledWith(expect.anything(), {
      minRole: "super_admin",
    });
  });

  it("403s support on POST — the guard runs before the body is read", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await POST(postRequest({ name: "Khách A" }));
    expect(response.status).toBe(403);
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("409s SLUG_TAKEN through the shared error shape", async () => {
    createTenant.mockRejectedValue(new AppError("SLUG_TAKEN"));
    const response = await POST(postRequest({ name: "Khách A", slug: "khach-a" }));
    expect(response.status).toBe(409);
  });
});

// --- The handover flow ---------------------------------------------------------

describe("/api/platform/tenants — provisioning", () => {
  it("201s with the owner-invite URL — the token's one appearance", async () => {
    const response = await POST(postRequest({ name: "Khách A" }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.tenant).toMatchObject({ id: TENANT, status: "active" });
    // From AUTH_URL, not from the request's `http://localhost`.
    expect(body.ownerInviteUrl).toBe(`https://mysp.example/join/${TOKEN}`);
    expect(createTenant).toHaveBeenCalledWith({
      name: "Khách A",
      slug: null,
      plan: null,
      actorAccountId: "acc-root",
      actorEmail: "root@mysp.vn",
    });
  });

  it("GET answers the platform list", async () => {
    const response = await GET(getRequest());
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ id: TENANT, memberCount: 3, status: "active" });
  });
});
