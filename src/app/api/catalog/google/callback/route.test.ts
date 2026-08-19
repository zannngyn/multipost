import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The browser-facing half of the Google connect flow (E2 step 2). No database
 * and no Google here: what is tested is the boundary contract of the route.
 *
 *   1. the tenant id comes from the httpOnly COOKIE, never from the query
 *      string — otherwise anybody could connect their account into someone
 *      else's tenant just by editing a URL;
 *   2. the one-time state cookie is cleared on EVERY exit, including the error
 *      ones — a nonce that survives a failed attempt can be replayed;
 *   3. a failure redirects with the AppError CODE, which is what lets the screen
 *      show a sentence instead of "đã xảy ra lỗi".
 */

const completeGoogleConnect = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn(async () => ({ email: "operator@example.com" }));

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { connectGoogleDrive: { completeGoogleConnect } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { GOOGLE_OAUTH_STATE_COOKIE } = await import("../_lib/oauth-state-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";
const STATE = "a".repeat(64);

function request(query: string, cookiePayload?: unknown): Request {
  const headers = new Headers();
  if (cookiePayload !== undefined) {
    const value =
      typeof cookiePayload === "string"
        ? cookiePayload
        : encodeURIComponent(JSON.stringify(cookiePayload));
    headers.set("cookie", `${GOOGLE_OAUTH_STATE_COOKIE}=${value}`);
  }
  return new Request(`http://localhost/api/catalog/google/callback${query}`, { headers });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "", "http://localhost");
}

beforeEach(() => {
  vi.clearAllMocks();
  completeGoogleConnect.mockResolvedValue({ state: "connected" });
  getOperatorSession.mockResolvedValue({ email: "operator@example.com" });
});

describe("GET /api/catalog/google/callback — edge cases first", () => {
  it("treats a declined consent as a normal outcome, not an error", async () => {
    const response = await GET(
      request("?error=access_denied", { state: STATE, tenantId: TENANT }),
    );

    expect(response.status).toBe(302);
    expect(location(response).search).toBe("?google=cancelled");
    expect(completeGoogleConnect).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("passes an EMPTY tenant id when there is no cookie — the usecase must refuse it", async () => {
    completeGoogleConnect.mockRejectedValueOnce(
      new AppError("GOOGLE_CONNECT_STATE_INVALID", { message: "no state cookie" }),
    );

    const response = await GET(request(`?code=code-1&state=${STATE}`));

    expect(completeGoogleConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "", expectedState: "" }),
    );
    expect(location(response).searchParams.get("reason")).toBe("GOOGLE_CONNECT_STATE_INVALID");
  });

  it("never takes the tenant id from the query string", async () => {
    const attacker = "11111111-1111-1111-1111-111111111111";

    await GET(
      request(`?code=code-1&state=${STATE}&tenantId=${attacker}`, {
        state: STATE,
        tenantId: TENANT,
      }),
    );

    expect(completeGoogleConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it("logs a malformed cookie and still ends the flow cleanly", async () => {
    completeGoogleConnect.mockRejectedValueOnce(
      new AppError("GOOGLE_CONNECT_STATE_INVALID", { message: "no state cookie" }),
    );

    const response = await GET(request(`?code=code-1&state=${STATE}`, "not-json"));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "STATE_COOKIE_MALFORMED" }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("redirects with the error CODE so the screen can say what to do", async () => {
    completeGoogleConnect.mockRejectedValueOnce(
      new AppError("GOOGLE_AUTH_EXPIRED", { message: "no refresh token" }),
    );

    const response = await GET(
      request(`?code=code-1&state=${STATE}`, { state: STATE, tenantId: TENANT }),
    );

    const url = location(response);
    expect(url.pathname).toBe("/sync");
    expect(url.searchParams.get("google")).toBe("error");
    expect(url.searchParams.get("reason")).toBe("GOOGLE_AUTH_EXPIRED");
    expect(logger.error).toHaveBeenCalled();
    // The nonce must not survive a failed attempt.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("maps an unknown failure to INTERNAL rather than leaking it", async () => {
    completeGoogleConnect.mockRejectedValueOnce(new Error("boom"));

    const response = await GET(
      request(`?code=code-1&state=${STATE}`, { state: STATE, tenantId: TENANT }),
    );

    expect(location(response).searchParams.get("reason")).toBe("INTERNAL");
  });

  it("lands on ?google=connected and clears the cookie on success", async () => {
    const response = await GET(
      request(`?code=code-1&state=${STATE}`, { state: STATE, tenantId: TENANT }),
    );

    expect(completeGoogleConnect).toHaveBeenCalledWith({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
      actorEmail: "operator@example.com",
    });
    expect(location(response).search).toBe("?google=connected");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("still connects when there is no session to name the actor", async () => {
    getOperatorSession.mockResolvedValueOnce(null as never);

    await GET(request(`?code=code-1&state=${STATE}`, { state: STATE, tenantId: TENANT }));

    expect(completeGoogleConnect).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmail: null }),
    );
  });
});
