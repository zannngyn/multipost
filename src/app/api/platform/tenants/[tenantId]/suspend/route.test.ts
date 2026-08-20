import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M3.2 — the status switches: super_admin only, target tenant from the PATH
 * (legitimate for platform APIs), mandatory ≥10-char reason, idempotent.
 * Covers the shared handler through /suspend; /activate is a spot check.
 */

const setTenantStatus = vi.fn();
const requirePlatformAdmin = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { platformTenants: { setTenantStatus }, requirePlatformAdmin },
  }),
  platformTenantId: (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
      throw new AppError("INVALID_INPUT");
    }
    return value;
  },
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { POST: ACTIVATE } = await import("../activate/route");

const TENANT = "00000000-0000-0000-0000-00000000d00d";
const REASON = "Khách nợ phí 3 tháng liên tiếp";

const call = (
  handler: typeof POST,
  body: unknown,
  tenantId = TENANT,
  path = "suspend",
) =>
  handler(
    new Request(`http://localhost/api/platform/tenants/${tenantId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tenantId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "root@mysp.vn", accountId: "acc-root" });
  requirePlatformAdmin.mockResolvedValue({ accountId: "acc-root", platformRole: "super_admin" });
  setTenantStatus.mockResolvedValue({ tenantId: TENANT, status: "suspended", already: false });
});

// --- Refusals first -----------------------------------------------------------

describe("POST .../suspend — refusals", () => {
  it("403s support — mutations are super_admin work", async () => {
    requirePlatformAdmin.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await call(POST, { reason: REASON });
    expect(response.status).toBe(403);
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it("400s a reason under 10 characters — the book entry is mandatory", async () => {
    const response = await call(POST, { reason: "spam" });
    expect(response.status).toBe(400);
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it("400s a malformed tenant id in the path", async () => {
    const response = await call(POST, { reason: REASON }, "not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("404s an unknown tenant", async () => {
    setTenantStatus.mockRejectedValue(new AppError("TENANT_NOT_FOUND"));
    const response = await call(POST, { reason: REASON });
    expect(response.status).toBe(404);
  });
});

// --- The switches --------------------------------------------------------------

describe("POST .../suspend and .../activate", () => {
  it("suspends with the path's tenant and the actor from the platform context", async () => {
    const response = await call(POST, { reason: REASON });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "suspended", already: false });
    expect(setTenantStatus).toHaveBeenCalledWith({
      tenantId: TENANT,
      status: "suspended",
      reason: REASON,
      actorAccountId: "acc-root",
      actorEmail: "root@mysp.vn",
    });
  });

  it("answers already:true idempotently for a tenant in that state", async () => {
    setTenantStatus.mockResolvedValue({ tenantId: TENANT, status: "suspended", already: true });
    const response = await call(POST, { reason: REASON });
    await expect(response.json()).resolves.toMatchObject({ already: true });
  });

  it("activate flips the other way through the same handler", async () => {
    setTenantStatus.mockResolvedValue({ tenantId: TENANT, status: "active", already: false });
    const response = await call(ACTIVATE, { reason: REASON }, TENANT, "activate");

    expect(response.status).toBe(200);
    expect(setTenantStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", reason: REASON }),
    );
  });
});
