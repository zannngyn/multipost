import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/** M2.3 — GET /api/members: admin-gated, isYou from the session, no session key. */

const listMembers = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { members: { listMembers }, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");

const TENANT = "00000000-0000-0000-0000-000000000001";
const request = () => new Request("http://localhost/api/members");

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@x.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  listMembers.mockResolvedValue([
    {
      membershipId: "m-1",
      accountId: "acc-1",
      displayName: "Admin",
      email: "admin@x.vn",
      role: "admin",
      status: "active",
      joinedAt: "2026-08-20T05:00:00.000Z",
      isYou: true,
    },
  ]);
});

describe("GET /api/members", () => {
  it("403s below admin, before listing anyone", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("lists with the actor from the session so the UI knows which row is YOU", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ isYou: true, status: "active" });
    expect(listMembers).toHaveBeenCalledWith({ tenantId: TENANT, actorAccountId: "acc-1" });
    // The session KEY never appears; `email` is the attribute address.
    expect(JSON.stringify(body)).not.toContain("sessionEmail");
  });
});
