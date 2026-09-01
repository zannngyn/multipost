import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The browser-facing half of the Facebook connect flow (E5.1 step 2, M1.3b).
 * Same contract as the Google twin: server-side state row decides tenant and
 * account, the claim is single-use, the current session must still be the
 * starter AND an admin, and every refusal is one indistinguishable
 * STATE_MISMATCH redirect.
 */

const completeFacebookConnect = vi.fn();
const claim = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      connectChannels: { completeFacebookConnect },
      oauthStates: { claim },
      requireTenant,
    },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("../route");
const { OAUTH_STATE_COOKIE } = await import("../../_lib/oauth-state-cookie");
const { OAUTH_RETURN_COOKIE } = await import("@/app/api/_lib/oauth-return-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const NONCE = "b".repeat(64);

function request(query: string, nonce?: string, extraCookie = ""): Request {
  const headers = new Headers();
  if (nonce !== undefined) {
    headers.set("cookie", `${OAUTH_STATE_COOKIE}=${nonce}${extraCookie}`);
  }
  return new Request(`http://localhost/api/channels/callback${query}`, { headers });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "", "http://localhost");
}

beforeEach(() => {
  vi.clearAllMocks();
  completeFacebookConnect.mockResolvedValue({ imported: 2, updated: 1, skipped: 0 });
  claim.mockResolvedValue({ tenantId: TENANT, accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  getOperatorSession.mockResolvedValue({ email: "operator@example.com", accountId: "acc-1" });
});

// --- Refusals first -----------------------------------------------------------

describe("GET /api/channels/callback — refusals", () => {
  it("redirects STATE_MISMATCH for a forged/absent state, and never imports", async () => {
    const response = await GET(request(`?code=abc&state=${NONCE}`)); // no cookie

    expect(response.status).toBe(302);
    const target = location(response);
    expect(target.pathname).toBe("/channels");
    expect(target.searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(completeFacebookConnect).not.toHaveBeenCalled();
  });

  it("refuses a nonce that was already used — single-use", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(completeFacebookConnect).not.toHaveBeenCalled();
  });

  it("refuses a session that is not the flow starter", async () => {
    getOperatorSession.mockResolvedValue({ email: "thief@example.com", accountId: "acc-9" });

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(completeFacebookConnect).not.toHaveBeenCalled();
  });

  it("refuses when the role was demoted mid-consent — fresh tier-S check", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(requireTenant).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1" }),
      TENANT,
      { tier: "S", minRole: "admin" },
    );
    expect(completeFacebookConnect).not.toHaveBeenCalled();
  });

  it("clears the one-time cookie on every refusal", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(response.headers.get("set-cookie")).toContain(`${OAUTH_STATE_COOKIE}=;`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

// --- Decline ------------------------------------------------------------------

describe("GET /api/channels/callback — decline", () => {
  it("treats access_denied as a choice and burns nothing", async () => {
    const response = await GET(request("?error=access_denied", NONCE));

    expect(location(response).searchParams.get("connect")).toBe("cancelled");
    expect(claim).not.toHaveBeenCalled();
  });
});

// --- Happy path ---------------------------------------------------------------

describe("GET /api/channels/callback — success", () => {
  it("imports into the tenant of the STATE ROW, re-authorised fresh", async () => {
    const response = await GET(request(`?code=the-code&state=${NONCE}`, NONCE));

    const target = location(response);
    expect(target.searchParams.get("connected")).toBe("3");
    expect(target.searchParams.get("new")).toBe("2");
    expect(completeFacebookConnect).toHaveBeenCalledWith({
      tenantId: TENANT,
      code: "the-code",
      state: NONCE,
      expectedState: NONCE,
      actorEmail: "operator@example.com",
    });
  });

  it("ignores an active-tenant cookie switched mid-consent — the row wins", async () => {
    const response = await GET(
      request(`?code=c&state=${NONCE}`, NONCE, `; mysp_active_tenant=${OTHER_TENANT}`),
    );

    expect(location(response).searchParams.get("connected")).toBe("3");
    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, expect.anything());
    expect(completeFacebookConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});

// --- Where the browser lands --------------------------------------------------

describe("GET /api/channels/callback — return target", () => {
  /** Same round trip, but started from the onboarding slideshow. */
  function fromOnboarding(query: string, nonce = NONCE): Request {
    const headers = new Headers();
    headers.set("cookie", `${OAUTH_STATE_COOKIE}=${nonce}; ${OAUTH_RETURN_COOKIE}=onboarding`);
    return new Request(`http://localhost/api/channels/callback${query}`, { headers });
  }

  it("keeps /channels for every entry point that did not come from onboarding", async () => {
    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    const target = location(response);
    expect(target.pathname).toBe("/channels");
    expect(target.searchParams.get("connected")).toBe("3");
    expect(target.searchParams.get("new")).toBe("2");
    expect(target.searchParams.get("skipped")).toBe("0");
  });

  it("carries the import tally back into the slideshow", async () => {
    // Slide 03 prints these numbers, so they have to survive the reroute whole.
    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("step")).toBe("facebook");
    expect(target.searchParams.get("connected")).toBe("3");
    expect(target.searchParams.get("new")).toBe("2");
    expect(target.searchParams.get("skipped")).toBe("0");
  });

  it("returns the CANCELLED branch to the slide as well", async () => {
    // Cancelling and landing on /channels mid-slideshow is the exact bug this
    // mechanism exists to prevent.
    const response = await GET(fromOnboarding("?error=access_denied"));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("step")).toBe("facebook");
    expect(target.searchParams.get("connect")).toBe("cancelled");
  });

  it("returns the STATE_MISMATCH branch to the slide as well", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("reason")).toBe("STATE_MISMATCH");
  });

  it("returns the thrown-error branch to the slide as well", async () => {
    completeFacebookConnect.mockRejectedValue(new AppError("CHANNEL_NOT_CONFIGURED"));

    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("reason")).toBe("CHANNEL_NOT_CONFIGURED");
  });

  it("clears the return flag on every exit, so the next connect starts clean", async () => {
    const response = await GET(fromOnboarding("?error=access_denied"));

    const cookies = response.headers.getSetCookie();
    // Two cookies, so `Headers.append`: an object literal would keep only one.
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=;`))).toBe(true);
    expect(
      cookies.some((c) => c.startsWith(`${OAUTH_RETURN_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });
});
