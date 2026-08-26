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
const { OAUTH_RETURN_COOKIE } = await import("@/app/api/_lib/oauth-return-cookie");

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

// --- Where the round trip is told to land -------------------------------------

describe("GET /api/channels/connect — return target", () => {
  const returnCookie = (response: Response): string =>
    response.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_RETURN_COOKIE}=`)) ?? "";

  it("clears any stale return flag when the connect starts from /channels", async () => {
    // The historic entry point must keep landing on /channels, and an abandoned
    // onboarding attempt from ten minutes ago must not hijack it. Declaring the
    // destination on EVERY connect is what keeps the two doors independent.
    const response = await GET(request());

    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=;`);
    expect(returnCookie(response)).toContain("Max-Age=0");
  });

  it("flags the round trip when the connect starts in onboarding", async () => {
    const response = await GET(
      new Request("http://localhost/api/channels/connect?return=onboarding"),
    );

    // Both cookies must survive: an object literal would keep only the last.
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.includes(`${OAUTH_STATE_COOKIE}=${NONCE}`))).toBe(true);
    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=onboarding`);
    expect(returnCookie(response)).toContain("SameSite=Lax");
    expect(returnCookie(response)).toContain("HttpOnly");
  });

  it("ignores an unknown return value rather than trusting it", async () => {
    const response = await GET(
      new Request("http://localhost/api/channels/connect?return=https://evil.test"),
    );

    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=;`);
  });

  it("redirects instead of answering JSON when the Meta app is missing mid-slideshow", async () => {
    // A raw JSON page in the middle of the slideshow is a dead end: there is
    // no screen left to read it on (spec §12).
    startFacebookConnect.mockRejectedValue(new AppError("CHANNEL_NOT_CONFIGURED"));

    const response = await GET(
      new Request("http://localhost/api/channels/connect?return=onboarding"),
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("step")).toBe("facebook");
    expect(target.searchParams.get("reason")).toBe("CHANNEL_NOT_CONFIGURED");
    expect(logger.error).toHaveBeenCalled();
  });

  it("keeps the JSON error body for the /channels entry point", async () => {
    // Unchanged for everyone outside onboarding — the operator is still on the
    // channels screen and can read the body (doc 10 §3).
    startFacebookConnect.mockRejectedValue(new AppError("CHANNEL_NOT_CONFIGURED"));

    const response = await GET(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
  });
});
