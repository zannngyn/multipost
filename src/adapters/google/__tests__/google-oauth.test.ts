import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@/core/ports/infra";

/**
 * The Google OAuth round trip (E2) against a mocked google-auth-library: no
 * live call is made, so what gets tested is the boundary contract — missing
 * env, the consent parameters that guarantee a refresh token, schema
 * validation of the answers, and the error mapping.
 */

const generateAuthUrlMock = vi.fn();
const getTokenMock = vi.fn();
const setCredentialsMock = vi.fn();
const revokeTokenMock = vi.fn();
const userinfoGetMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        constructor(public readonly options: unknown) {}
        generateAuthUrl = generateAuthUrlMock;
        getToken = getTokenMock;
        setCredentials = setCredentialsMock;
        revokeToken = revokeTokenMock;
      },
    },
    oauth2: () => ({ userinfo: { get: userinfoGetMock } }),
  },
}));

const { makeGoogleOAuthClient, GOOGLE_DRIVE_CONNECT_SCOPES, isRevokedGrant } = await import(
  "../google-oauth"
);

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

const FULL_CREDENTIALS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/catalog/google/callback",
};

function build(credentials: Record<string, string | null> = FULL_CREDENTIALS) {
  return makeGoogleOAuthClient({
    logger: makeLogger(),
    readCredentials: () => credentials,
  });
}

beforeEach(() => {
  generateAuthUrlMock.mockReset();
  getTokenMock.mockReset();
  revokeTokenMock.mockReset();
  userinfoGetMock.mockReset();
});

describe("buildAuthorizeUrl", () => {
  it("names every missing environment variable instead of failing at Google", () => {
    const client = build({ clientId: null, clientSecret: null, redirectUri: null });
    const error = (() => {
      try {
        client.buildAuthorizeUrl({ state: "a".repeat(64) });
        return null;
      } catch (caught) {
        return caught as { code: string; context: Record<string, unknown>; userMessage: string };
      }
    })();

    expect(error).toMatchObject({ code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
    expect(error?.context.missing).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
    ]);
    expect(error?.userMessage).toContain("GOOGLE_OAUTH_REDIRECT_URI");
  });

  it("reports only the variable that is actually missing", () => {
    const client = build({ ...FULL_CREDENTIALS, redirectUri: "" });
    expect(() => client.buildAuthorizeUrl({ state: "a".repeat(64) })).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ missing: ["GOOGLE_OAUTH_REDIRECT_URI"] }) }),
    );
  });

  it("refuses to build a consent URL without a CSRF state", () => {
    expect(() => build().buildAuthorizeUrl({ state: "  " })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(generateAuthUrlMock).not.toHaveBeenCalled();
  });

  it("asks for offline access AND a fresh consent — the pair that returns a refresh token", () => {
    generateAuthUrlMock.mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    const url = build().buildAuthorizeUrl({ state: "a".repeat(64) });

    expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(generateAuthUrlMock).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: [...GOOGLE_DRIVE_CONNECT_SCOPES],
      state: "a".repeat(64),
    });
    // Read-only, both APIs, plus the identity of the account.
    expect(GOOGLE_DRIVE_CONNECT_SCOPES).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "openid",
      "email",
    ]);
  });
});

describe("exchangeCode", () => {
  it("refuses an empty authorization code before calling Google", async () => {
    await expect(build().exchangeCode({ code: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("maps a re-used/expired code (invalid_grant) to GOOGLE_AUTH_EXPIRED", async () => {
    getTokenMock.mockRejectedValueOnce({
      response: { data: { error: "invalid_grant" }, status: 400 },
    });
    await expect(build().exchangeCode({ code: "code-1" })).rejects.toMatchObject({
      code: "GOOGLE_AUTH_EXPIRED",
    });
  });

  it("maps bad app credentials (invalid_client) to GOOGLE_OAUTH_NOT_CONFIGURED", async () => {
    getTokenMock.mockRejectedValueOnce({
      response: { data: { error: "invalid_client" }, status: 401 },
    });
    await expect(build().exchangeCode({ code: "code-1" })).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
    });
  });

  it("maps a Google outage to a retryable DRIVE_ERROR", async () => {
    getTokenMock.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: 503 }));
    await expect(build().exchangeCode({ code: "code-1" })).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { retryable: true },
    });
  });

  it("rejects a token answer without an access token", async () => {
    getTokenMock.mockResolvedValueOnce({ tokens: { refresh_token: "r" } });
    await expect(build().exchangeCode({ code: "code-1" })).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { reason: "INVALID_ANSWER_SHAPE" },
    });
    expect(userinfoGetMock).not.toHaveBeenCalled();
  });

  it("rejects a userinfo answer without an e-mail", async () => {
    getTokenMock.mockResolvedValueOnce({ tokens: { access_token: "a", refresh_token: "r" } });
    userinfoGetMock.mockResolvedValueOnce({ data: { id: "1" } });
    await expect(build().exchangeCode({ code: "code-1" })).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { step: "read_userinfo", reason: "INVALID_ANSWER_SHAPE" },
    });
  });

  it("returns the refresh token, the account e-mail and the GRANTED scopes", async () => {
    getTokenMock.mockResolvedValueOnce({
      tokens: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        scope:
          "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly openid",
      },
    });
    userinfoGetMock.mockResolvedValueOnce({ data: { email: "shop@gmail.com" } });

    await expect(build().exchangeCode({ code: "code-1" })).resolves.toEqual({
      refreshToken: "refresh-1",
      email: "shop@gmail.com",
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "openid",
      ],
    });
  });

  it("reports an absent refresh token as an empty string, leaving the verdict to the usecase", async () => {
    getTokenMock.mockResolvedValueOnce({ tokens: { access_token: "access-1", scope: "openid" } });
    userinfoGetMock.mockResolvedValueOnce({ data: { email: "shop@gmail.com" } });

    await expect(build().exchangeCode({ code: "code-1" })).resolves.toMatchObject({
      refreshToken: "",
    });
  });
});

describe("revoke", () => {
  it("refuses an empty token", async () => {
    await expect(build().revoke({ refreshToken: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });

  it("hands the token to Google's revoke endpoint", async () => {
    revokeTokenMock.mockResolvedValueOnce({ data: {} });
    await build().revoke({ refreshToken: "refresh-1" });
    expect(revokeTokenMock).toHaveBeenCalledWith("refresh-1");
  });
});

describe("isRevokedGrant", () => {
  it("recognises the two identifiers that mean 'reconnect is the only fix'", () => {
    expect(isRevokedGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isRevokedGrant({ response: { data: { error: "unauthorized_client" } } })).toBe(true);
  });

  it("does not treat a rate limit or a plain outage as a revoked grant", () => {
    expect(isRevokedGrant({ response: { data: { error: "rateLimitExceeded" }, status: 429 } })).toBe(
      false,
    );
    expect(isRevokedGrant(new Error("socket hang up"))).toBe(false);
    expect(isRevokedGrant(null)).toBe(false);
  });
});
