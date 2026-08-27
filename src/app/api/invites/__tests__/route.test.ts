import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M2.2 — boundary contract of `/api/invites` (list + mint). What matters:
 * admin-gated at the route, the ladder refusal surfaces as 403, and the raw
 * token appears ONLY in the create response.
 */

const listInvites = vi.fn();
const createInvite = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { invites: { listInvites, createInvite }, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

// The link origin comes from AUTH_URL (canonical, https behind Caddy) — set it
// to something OTHER than the request host so the assertion below proves the
// request cannot influence the link.
vi.stubEnv("AUTH_URL", "https://mysp.example");

const { GET, POST } = await import("../route");

const TENANT = "00000000-0000-0000-0000-000000000001";
const TOKEN = "t".repeat(64);

const getRequest = () => new Request("http://localhost/api/invites");
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@x.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  listInvites.mockResolvedValue([]);
  createInvite.mockResolvedValue({
    id: "inv-1",
    role: "editor",
    token: TOKEN,
    expiresAt: new Date("2026-08-27T05:00:00Z"),
  });
});

// --- Refusals first -----------------------------------------------------------

describe("/api/invites — refusals", () => {
  it("403s a viewer on GET — the guard runs before the list", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(listInvites).not.toHaveBeenCalled();
  });

  it("403s INVITE_ROLE_FORBIDDEN when an admin asks for an admin invite", async () => {
    createInvite.mockRejectedValue(new AppError("INVITE_ROLE_FORBIDDEN"));
    const response = await POST(postRequest({ role: "admin" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "INVITE_ROLE_FORBIDDEN" });
  });

  it("400s an unknown role at the boundary", async () => {
    const response = await POST(postRequest({ role: "superuser" }));
    expect(response.status).toBe(400);
    expect(createInvite).not.toHaveBeenCalled();
  });
});

// --- The token discipline -----------------------------------------------------

describe("/api/invites — token discipline", () => {
  it("POST hands the inviter's AUTHORISED role to the usecase and returns the join url once", async () => {
    const response = await POST(postRequest({ role: "editor" }));

    expect(response.status).toBe(201);
    const body = await response.json();
    // AUTH_URL's origin, NOT the request's (`http://localhost`): behind Caddy
    // the request scheme is the internal hop's, and a handed-out link must
    // carry the real one.
    expect(body.url).toBe(`https://mysp.example/join/${TOKEN}`);
    expect(createInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        inviterRole: "admin", // from requireTenant, never from the body
        inviterAccountId: "acc-1",
        role: "editor",
      }),
    );
  });

  it("GET answers the list WITHOUT any token field", async () => {
    listInvites.mockResolvedValue([
      {
        id: "inv-1",
        role: "editor",
        expiresAt: new Date("2026-08-27T05:00:00Z"),
        maxUses: 1,
        usedCount: 0,
        revokedAt: null,
        createdByEmail: "admin@x.vn",
      },
    ]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(Object.keys(body.items[0])).not.toContain("token");
    expect(Object.keys(body.items[0])).not.toContain("tokenHash");
  });
});
