import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The browser-facing half of the Google connect flow (E2 step 2, M1.3b).
 * No database and no Google here: what is tested is the boundary contract.
 *
 *   1. everything trusted comes from the SERVER-SIDE state row the cookie
 *      nonce points at — tenant and account are frozen at flow START, so a
 *      forged cookie or a mid-consent tenant switch moves nothing;
 *   2. the claim is single-use, and every refusal is the SAME
 *      `?reason=STATE_MISMATCH` redirect (no oracle);
 *   3. the CURRENT session must be the starter AND still admin (fresh);
 *   4. the one-time cookie is cleared on EVERY exit.
 */

const completeGoogleConnect = vi.fn();
const claim = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      connectGoogleDrive: { completeGoogleConnect },
      oauthStates: { claim },
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
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const NONCE = "a".repeat(64);

function request(query: string, nonce?: string): Request {
  const headers = new Headers();
  if (nonce !== undefined) headers.set("cookie", `${GOOGLE_OAUTH_STATE_COOKIE}=${nonce}`);
  return new Request(`http://localhost/api/catalog/google/callback${query}`, { headers });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "", "http://localhost");
}

beforeEach(() => {
  vi.clearAllMocks();
  completeGoogleConnect.mockResolvedValue({ state: "connected" });
  claim.mockResolvedValue({ tenantId: TENANT, accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  getOperatorSession.mockResolvedValue({ email: "operator@example.com", accountId: "acc-1" });
});

// --- Refusals first -----------------------------------------------------------

describe("GET /api/catalog/google/callback — refusals", () => {
  it("redirects STATE_MISMATCH without a cookie, and never claims", async () => {
    const response = await GET(request("?code=abc&state=xyz"));

    expect(response.status).toBe(302);
    const target = location(response);
    expect(target.pathname).toBe("/sync");
    expect(target.searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(claim).not.toHaveBeenCalled();
    expect(completeGoogleConnect).not.toHaveBeenCalled();
  });

  it("treats an edited/garbage cookie value as absent", async () => {
    const response = await GET(request("?code=abc&state=xyz", "not-a-nonce"));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(claim).not.toHaveBeenCalled();
  });

  it("redirects STATE_MISMATCH when the nonce was already used (claim refuses)", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(completeGoogleConnect).not.toHaveBeenCalled();
  });

  it("refuses a session that is NOT the flow starter — cookie theft", async () => {
    getOperatorSession.mockResolvedValue({ email: "someone.else@example.com", accountId: "acc-2" });

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(completeGoogleConnect).not.toHaveBeenCalled();
    // The nonce is still burned: a refusal must not leave it spendable.
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("refuses when the role was demoted mid-consent (fresh check throws FORBIDDEN)", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
    expect(completeGoogleConnect).not.toHaveBeenCalled();
  });

  it("refuses when the membership is gone (TENANT_NOT_FOUND) with the same reason", async () => {
    requireTenant.mockRejectedValue(new AppError("TENANT_NOT_FOUND"));

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("STATE_MISMATCH");
  });

  it("clears the one-time cookie on an error exit", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(response.headers.get("set-cookie")).toContain(`${GOOGLE_OAUTH_STATE_COOKIE}=;`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("redirects with the AppError code when the usecase itself fails", async () => {
    completeGoogleConnect.mockRejectedValue(new AppError("GOOGLE_AUTH_EXPIRED"));

    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("reason")).toBe("GOOGLE_AUTH_EXPIRED");
  });
});

// --- The decline path ---------------------------------------------------------

describe("GET /api/catalog/google/callback — decline", () => {
  it("treats access_denied as a choice, not an error, and burns nothing", async () => {
    const response = await GET(request("?error=access_denied", NONCE));

    expect(location(response).searchParams.get("google")).toBe("cancelled");
    expect(claim).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// --- Happy path ---------------------------------------------------------------

describe("GET /api/catalog/google/callback — success", () => {
  it("writes into the tenant of the STATE ROW, re-authorised fresh", async () => {
    const response = await GET(request(`?code=the-code&state=${NONCE}`, NONCE));

    expect(location(response).searchParams.get("google")).toBe("connected");
    // The claim decides the tenant; the fresh admin check runs against IT.
    expect(requireTenant).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1" }),
      TENANT,
      { tier: "S", minRole: "admin" },
    );
    expect(completeGoogleConnect).toHaveBeenCalledWith({
      tenantId: TENANT,
      code: "the-code",
      state: NONCE,
      expectedState: NONCE,
      actorEmail: "operator@example.com",
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("STILL writes into the row's tenant when the active-tenant cookie points elsewhere", async () => {
    // The operator switched company in another tab mid-consent: the selector
    // cookie now says OTHER_TENANT, but the state row froze TENANT at start.
    const headers = new Headers();
    headers.set(
      "cookie",
      `${GOOGLE_OAUTH_STATE_COOKIE}=${NONCE}; mysp_active_tenant=${OTHER_TENANT}`,
    );
    const response = await GET(
      new Request(`http://localhost/api/catalog/google/callback?code=c&state=${NONCE}`, { headers }),
    );

    expect(location(response).searchParams.get("google")).toBe("connected");
    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, expect.anything());
    expect(completeGoogleConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});

// --- Where the browser lands --------------------------------------------------

describe("GET /api/catalog/google/callback — return target", () => {
  /** Same round trip, but started from the onboarding slideshow. */
  function fromOnboarding(query: string, nonce = NONCE): Request {
    const headers = new Headers();
    headers.set(
      "cookie",
      `${GOOGLE_OAUTH_STATE_COOKIE}=${nonce}; ${OAUTH_RETURN_COOKIE}=onboarding`,
    );
    return new Request(`http://localhost/api/catalog/google/callback${query}`, { headers });
  }

  it("keeps /sync for every entry point that did not come from onboarding", async () => {
    const response = await GET(request(`?code=abc&state=${NONCE}`, NONCE));

    const target = location(response);
    expect(target.pathname).toBe("/sync");
    expect(target.searchParams.get("google")).toBe("connected");
  });

  it("returns a successful connect to the slide it started from", async () => {
    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("step")).toBe("data");
    expect(target.searchParams.get("google")).toBe("connected");
  });

  it("returns the CANCELLED branch to the slide as well", async () => {
    // Cancelling and landing on /sync mid-slideshow is the exact bug this
    // mechanism exists to prevent.
    const response = await GET(fromOnboarding("?error=access_denied"));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("google")).toBe("cancelled");
  });

  it("returns the STATE_MISMATCH branch to the slide as well", async () => {
    claim.mockResolvedValue(null);

    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("reason")).toBe("STATE_MISMATCH");
  });

  it("returns the thrown-error branch to the slide as well", async () => {
    completeGoogleConnect.mockRejectedValue(new AppError("GOOGLE_AUTH_EXPIRED"));

    const response = await GET(fromOnboarding(`?code=abc&state=${NONCE}`));

    const target = location(response);
    expect(target.pathname).toBe("/onboarding");
    expect(target.searchParams.get("reason")).toBe("GOOGLE_AUTH_EXPIRED");
  });

  it("clears the return flag on every exit, so the next connect starts clean", async () => {
    const response = await GET(fromOnboarding("?error=access_denied"));

    const cookies = response.headers.getSetCookie();
    // Two cookies, so `Headers.append`: an object literal would keep only one.
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=;`))).toBe(true);
    expect(
      cookies.some((c) => c.startsWith(`${OAUTH_RETURN_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });
});
