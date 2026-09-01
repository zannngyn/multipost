import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The start of the Google connect flow (E2 step 1, M1.3b) — same contract as
 * the Facebook twin: tenant from `requireTenant` (tier S, admin), state row
 * written before the browser leaves, cookie carries only the opaque nonce.
 */

const startGoogleConnect = vi.fn();
const issue = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      connectGoogleDrive: { startGoogleConnect },
      oauthStates: { issue },
      requireTenant,
    },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("../route");
const { GOOGLE_OAUTH_STATE_COOKIE } = await import("../../_lib/oauth-state-cookie");
const { OAUTH_RETURN_COOKIE } = await import("@/app/api/_lib/oauth-return-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";
const NONCE = "d".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@example.com", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  startGoogleConnect.mockResolvedValue({
    tenantId: TENANT,
    state: NONCE,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
  });
  issue.mockResolvedValue(undefined);
});

const request = () => new Request("http://localhost/api/catalog/google/connect");

describe("GET /api/catalog/google/connect", () => {
  // --- Refusals first ---------------------------------------------------------
  it("403s a viewer — connecting a credential source is admin work", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(startGoogleConnect).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("keeps JSON for a missing OAuth app (operator is still on the screen)", async () => {
    startGoogleConnect.mockRejectedValue(new AppError("GOOGLE_OAUTH_NOT_CONFIGURED"));

    const response = await GET(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  // --- Happy path -------------------------------------------------------------
  it("binds (tenant, account) server-side and sends only the nonce in the cookie", async () => {
    const response = await GET(request());

    expect(response.status).toBe(302);
    expect(issue).toHaveBeenCalledWith({
      nonce: NONCE,
      tenantId: TENANT,
      accountId: "acc-1",
      purpose: "google_drive",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GOOGLE_OAUTH_STATE_COOKIE}=${NONCE}`);
    expect(cookie).not.toContain(TENANT);
  });
});

// --- Where the round trip is told to land -------------------------------------

describe("GET /api/catalog/google/connect — return target", () => {
  const returnCookie = (response: Response): string =>
    response.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_RETURN_COOKIE}=`)) ?? "";

  it("clears any stale return flag when the connect starts from /sync", async () => {
    // The historic entry point must keep landing on /sync, and an abandoned
    // onboarding attempt from ten minutes ago must not hijack it.
    const response = await GET(request());

    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=;`);
    expect(returnCookie(response)).toContain("Max-Age=0");
  });

  it("flags the round trip when the connect starts in onboarding", async () => {
    const response = await GET(
      new Request("http://localhost/api/catalog/google/connect?return=onboarding"),
    );

    // Both cookies must survive: an object literal would keep only the last.
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.includes(`${GOOGLE_OAUTH_STATE_COOKIE}=${NONCE}`))).toBe(true);
    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=onboarding`);
    expect(returnCookie(response)).toContain("SameSite=Lax");
  });

  it("ignores an unknown return value rather than trusting it", async () => {
    const response = await GET(
      new Request("http://localhost/api/catalog/google/connect?return=https://evil.test"),
    );

    expect(returnCookie(response)).toContain(`${OAUTH_RETURN_COOKIE}=;`);
  });

  it("redirects instead of answering JSON when the OAuth app is missing mid-slideshow", async () => {
    // A raw JSON page in the middle of the slideshow is a dead end: there is
    // no screen left to read it on.
    startGoogleConnect.mockRejectedValue(new AppError("GOOGLE_OAUTH_NOT_CONFIGURED"));

    const response = await GET(
      new Request("http://localhost/api/catalog/google/connect?return=onboarding"),
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("step")).toBe("data");
    expect(target.searchParams.get("reason")).toBe("GOOGLE_OAUTH_NOT_CONFIGURED");
    expect(logger.error).toHaveBeenCalled();
  });
});
