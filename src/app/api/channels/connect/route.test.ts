import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The start of the Facebook connect flow (E5.1 step 1, M1.3b): the tenant
 * comes from `requireTenant` (tier S, admin), the state row is written BEFORE
 * the browser leaves, and the cookie carries only the opaque nonce.
 */

const startFacebookConnect = vi.fn();
const issue = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      connectChannels: { startFacebookConnect },
      oauthStates: { issue },
      requireTenant,
    },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { OAUTH_STATE_COOKIE } = await import("../_lib/oauth-state-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";
const NONCE = "c".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@example.com", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  startFacebookConnect.mockResolvedValue({
    tenantId: TENANT,
    state: NONCE,
    authorizeUrl: "https://www.facebook.com/dialog/oauth?x=1",
  });
  issue.mockResolvedValue(undefined);
});

const request = () => new Request("http://localhost/api/channels/connect");

// --- Refusals first -----------------------------------------------------------

describe("GET /api/channels/connect — refusals", () => {
  it("403s a viewer — connecting a credential is admin work", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(startFacebookConnect).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("401s without a session, as JSON (connect keeps JSON for errors)", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(startFacebookConnect).not.toHaveBeenCalled();
  });

  it("does NOT set a state cookie when the flow could not start", async () => {
    startFacebookConnect.mockRejectedValue(new AppError("GOOGLE_OAUTH_NOT_CONFIGURED"));

    const response = await GET(request());

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });
});

// --- Happy path ---------------------------------------------------------------

describe("GET /api/channels/connect — start", () => {
  it("binds (tenant, account) server-side and sends only the nonce in the cookie", async () => {
    const response = await GET(request());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("facebook.com");

    // Server-side row first, bound to the authorised tenant + account.
    expect(issue).toHaveBeenCalledWith({
      nonce: NONCE,
      tenantId: TENANT,
      accountId: "acc-1",
      purpose: "facebook_pages",
    });

    // Cookie: opaque nonce only — no tenant id anywhere in it.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=${NONCE}`);
    expect(cookie).not.toContain(TENANT);
    expect(cookie).toContain("HttpOnly");
  });
});
