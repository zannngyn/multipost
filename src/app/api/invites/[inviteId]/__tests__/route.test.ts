import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/** M2.2 — revoke: admin-gated, idempotent, unknown id behaves as absent. */

const revokeInvite = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { invites: { revokeInvite }, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { DELETE } = await import("../route");

const TENANT = "00000000-0000-0000-0000-000000000001";
const INVITE_ID = "11111111-2222-3333-4444-555555555555";

const request = () =>
  new Request(`http://localhost/api/invites/${INVITE_ID}`, { method: "DELETE" });
const call = (inviteId = INVITE_ID) =>
  DELETE(request(), { params: Promise.resolve({ inviteId }) });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@x.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  revokeInvite.mockResolvedValue({ id: INVITE_ID, revoked: true });
});

describe("DELETE /api/invites/[inviteId]", () => {
  // --- Refusals first ---------------------------------------------------------
  it("403s below admin, before touching the invite", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await call();
    expect(response.status).toBe(403);
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it("400s a malformed id instead of letting Postgres 503 on the cast", async () => {
    const response = await call("not-a-uuid");
    expect(response.status).toBe(400);
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it("404s INVITE_INVALID for an id this tenant does not hold", async () => {
    revokeInvite.mockRejectedValue(new AppError("INVITE_INVALID"));
    const response = await call();
    expect(response.status).toBe(404);
  });

  // --- Happy path -------------------------------------------------------------
  it("revokes within the AUTHORISED tenant and names the actor", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: INVITE_ID, revoked: true });
    expect(revokeInvite).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: INVITE_ID,
      actorAccountId: "acc-1",
      actorEmail: "admin@x.vn",
    });
  });
});
