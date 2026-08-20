import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M2.2 — boundary contract of `POST /api/join`: serves the NoMembership state
 * (no tenant context), one indistinguishable refusal, cookie switches on
 * success AND on the alreadyMember no-op.
 */

const joinWithInvite = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { joinWithInvite },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = "00000000-0000-0000-0000-00000000face";
const TOKEN = "k".repeat(64);
const TENANT_SUMMARY = { id: TENANT, name: "Công ty X", slug: "x", plan: "standard" };

const request = (body: unknown) =>
  new Request("http://localhost/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({
    email: "new@x.vn",
    name: "Newcomer",
    accountId: "acc-9",
  });
  joinWithInvite.mockResolvedValue({
    tenant: TENANT_SUMMARY,
    role: "editor",
    alreadyMember: false,
  });
});

// --- Refusals first -----------------------------------------------------------

describe("POST /api/join — refusals", () => {
  it("401s without a session — an invite is not a way around signing in", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await POST(request({ token: TOKEN }));
    expect(response.status).toBe(401);
    expect(joinWithInvite).not.toHaveBeenCalled();
  });

  it("404s a garbage token exactly like a wrong one — no shape oracle over HTTP", async () => {
    // The usecase refuses the shape with the SAME code as every other refusal;
    // a 400 here would tell a prober their guess at least LOOKED right.
    joinWithInvite.mockRejectedValue(new AppError("INVITE_INVALID"));
    const response = await POST(request({ token: "abc" }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "INVITE_INVALID" });
    expect(joinWithInvite).toHaveBeenCalledWith(expect.objectContaining({ token: "abc" }));
  });

  it("400s only a MISSING token — a malformed request, not a token probe", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(joinWithInvite).not.toHaveBeenCalled();
  });

  it("404s the ONE code for every invite refusal, and sets no cookie", async () => {
    joinWithInvite.mockRejectedValue(new AppError("INVITE_INVALID"));
    const response = await POST(request({ token: TOKEN }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "INVITE_INVALID" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

// --- Outcomes -----------------------------------------------------------------

describe("POST /api/join — outcomes", () => {
  it("joins and switches the active tenant to the invite's company", async () => {
    const response = await POST(request({ token: TOKEN }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tenant: TENANT_SUMMARY,
      role: "editor",
      alreadyMember: false,
    });
    expect(joinWithInvite).toHaveBeenCalledWith({
      accountId: "acc-9",
      sessionEmail: "new@x.vn",
      displayName: "Newcomer",
      token: TOKEN,
    });
    expect(response.headers.get("set-cookie")).toContain(`${ACTIVE_TENANT_COOKIE}=${TENANT}`);
  });

  it("answers the alreadyMember no-op as 200 WITH the cookie switch", async () => {
    joinWithInvite.mockResolvedValue({ tenant: TENANT_SUMMARY, role: "owner", alreadyMember: true });

    const response = await POST(request({ token: TOKEN }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ alreadyMember: true, role: "owner" });
    expect(response.headers.get("set-cookie")).toContain(`${ACTIVE_TENANT_COOKIE}=${TENANT}`);
  });
});
