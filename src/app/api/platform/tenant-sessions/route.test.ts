import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M3.3 — boundary contract of opening a support visit: support-role gated
 * (fresh), mandatory ≥10-char purpose, target tenant through the platform
 * constructor, cookie carries only the opaque session id.
 */

const open = vi.fn();
const requirePlatformAdmin = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { supportSessions: { open }, requirePlatformAdmin },
  }),
}));

vi.mock("@/composition/platform-tenant-id", () => ({
  platformTenantId: (value: unknown) => value,
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { SUPPORT_SESSION_COOKIE } = await import("@/app/_lib/support-session-cookie");

const TENANT = "00000000-0000-0000-0000-00000000d00d";
const SESSION_ID = "99999999-8888-7777-6666-555555555555";
const PURPOSE = "Điều tra lỗi đồng bộ catalog theo ticket #123";

const request = (body: unknown) =>
  new Request("http://localhost/api/platform/tenant-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "staff@mysp.vn", accountId: "acc-staff" });
  requirePlatformAdmin.mockResolvedValue({ accountId: "acc-staff", platformRole: "support" });
  open.mockResolvedValue({
    sessionId: SESSION_ID,
    tenant: { id: TENANT, name: "Khách A", slug: "khach-a" },
    expiresAt: new Date("2026-08-22T07:00:00Z"),
  });
});

// --- Refusals first -----------------------------------------------------------

describe("POST /api/platform/tenant-sessions — refusals", () => {
  it("403s an operator with NO platform role — before the body is read", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await POST(request({ tenantId: TENANT, purpose: PURPOSE }));
    expect(response.status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });

  it("gates at minRole SUPPORT — visiting is what support exists for", async () => {
    await POST(request({ tenantId: TENANT, purpose: PURPOSE }));
    expect(requirePlatformAdmin).toHaveBeenCalledWith(expect.anything(), { minRole: "support" });
  });

  it("400s a purpose under 10 characters — the visit's book entry is mandatory", async () => {
    const response = await POST(request({ tenantId: TENANT, purpose: "check" }));
    expect(response.status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it("404s an unknown/suspended target tenant", async () => {
    open.mockRejectedValue(new AppError("TENANT_NOT_FOUND"));
    const response = await POST(request({ tenantId: TENANT, purpose: PURPOSE }));
    expect(response.status).toBe(404);
  });
});

// --- The visit ------------------------------------------------------------------

describe("POST /api/platform/tenant-sessions — opening", () => {
  it("201s with the visit summary and sets ONLY the opaque id in the cookie", async () => {
    const response = await POST(request({ tenantId: TENANT, purpose: PURPOSE }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: SESSION_ID,
      tenant: { id: TENANT, name: "Khách A" },
    });
    expect(open).toHaveBeenCalledWith({
      tenantId: TENANT,
      purpose: PURPOSE,
      accountId: "acc-staff",
      actorEmail: "staff@mysp.vn",
    });

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SUPPORT_SESSION_COOKIE}=${SESSION_ID}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain(TENANT); // the cookie names nothing but the row
  });
});
