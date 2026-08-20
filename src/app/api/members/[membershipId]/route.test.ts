import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M2.3 — PUT/DELETE one member: the actor's role comes from the AUTHORISED
 * context (never the body), the ladder and LAST_OWNER refusals keep their
 * codes, and a malformed id dies as 400 before the database.
 */

const changeRole = vi.fn();
const removeMember = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { members: { changeRole, removeMember }, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { PUT, DELETE } = await import("./route");

const TENANT = "00000000-0000-0000-0000-000000000001";
const MEMBERSHIP = "11111111-2222-3333-4444-555555555555";

const put = (body: unknown, membershipId = MEMBERSHIP) =>
  PUT(
    new Request(`http://localhost/api/members/${membershipId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ membershipId }) },
  );
const del = (membershipId = MEMBERSHIP) =>
  DELETE(new Request(`http://localhost/api/members/${membershipId}`, { method: "DELETE" }), {
    params: Promise.resolve({ membershipId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "boss@x.vn", accountId: "acc-owner" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "owner", membershipVersion: 1 });
  changeRole.mockResolvedValue({ membershipId: MEMBERSHIP, accountId: "acc-2", role: "admin", version: 2 });
  removeMember.mockResolvedValue({ membershipId: MEMBERSHIP, accountId: "acc-2", role: "editor", version: 2 });
});

// --- Refusals first -----------------------------------------------------------

describe("PUT/DELETE /api/members/[membershipId] — refusals", () => {
  it("400s a malformed id instead of a Postgres cast 503", async () => {
    const response = await put({ role: "editor" }, "not-a-uuid");
    expect(response.status).toBe(400);
    expect(changeRole).not.toHaveBeenCalled();
  });

  it("403s FORBIDDEN when the ladder refuses (admin touching an admin)", async () => {
    changeRole.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await put({ role: "viewer" });
    expect(response.status).toBe(403);
  });

  it("409s LAST_OWNER with the transfer-first message", async () => {
    changeRole.mockRejectedValue(new AppError("LAST_OWNER"));
    const response = await put({ role: "editor" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("LAST_OWNER");
    expect(body.message).toContain("ít nhất một owner");
  });

  it("404s MEMBER_NOT_FOUND for an id of another tenant", async () => {
    removeMember.mockRejectedValue(new AppError("MEMBER_NOT_FOUND"));
    const response = await del();
    expect(response.status).toBe(404);
  });
});

// --- Happy paths --------------------------------------------------------------

describe("PUT/DELETE /api/members/[membershipId] — changes", () => {
  it("PUT hands the AUTHORISED actor role to the usecase, never the body's word", async () => {
    const response = await put({ role: "admin" });

    expect(response.status).toBe(200);
    expect(changeRole).toHaveBeenCalledWith({
      tenantId: TENANT,
      membershipId: MEMBERSHIP,
      role: "admin",
      actorRole: "owner", // from requireTenant
      actorAccountId: "acc-owner",
      actorEmail: "boss@x.vn",
    });
  });

  it("DELETE removes and answers the bumped version", async () => {
    const response = await del();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      membershipId: MEMBERSHIP,
      removed: true,
      version: 2,
    });
  });
});
