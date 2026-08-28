import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeFacebookOAuthClient, MAX_PAGES_OF_PAGES } from "../facebook-oauth";

/**
 * E5.1 against a FAKE fetch: every answer Facebook can give — the good one, an
 * error envelope, a second page of Pages, and a shape we did not agree on.
 *
 * What the assertions protect: no token ever reaches a log line, and a Graph
 * failure comes back as an instruction an operator can follow ("dán token mới"),
 * not as the publishing wording of graph-error-map.
 */

const USER_TOKEN = "USER-TOKEN-SECRET";
const LONG_TOKEN = "LONG-LIVED-TOKEN-SECRET";

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

interface FakeAnswer {
  status?: number;
  body?: unknown;
  /** Raw text wins over `body` — used for the "Graph answered HTML" case. */
  text?: string;
}

/** Asserts the promise rejected with an AppError, and hands it over typed. */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null).catch((e: unknown) => e);
  expect(AppError.is(error)).toBe(true);
  return error as AppError;
}

function fakeFetch(answers: FakeAnswer[]) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected extra request: ${String(input)}`);
    const body = answer.text ?? JSON.stringify(answer.body);
    return new Response(body, {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function harness(answers: FakeAnswer[], options: { appSecret?: string | null } = {}) {
  const lines: LogLine[] = [];
  const { impl, calls } = fakeFetch(answers);
  const client = makeFacebookOAuthClient({
    logger: recordingLogger(lines),
    appId: "1640548543911378",
    appSecret: options.appSecret === undefined ? "APP-SECRET" : options.appSecret,
    redirectUri: "https://mysp.example.com/api/channels/callback",
    version: "v23.0",
    fetchImpl: impl,
  });
  return { client, calls, lines };
}

/** No token, in any form, may appear anywhere in the log. */
function expectNoSecretsLogged(lines: LogLine[]): void {
  const serialised = JSON.stringify(lines);
  expect(serialised).not.toContain(USER_TOKEN);
  expect(serialised).not.toContain(LONG_TOKEN);
  expect(serialised).not.toContain("APP-SECRET");
  expect(serialised).not.toContain("page-token");
}

// --- Edge cases first -------------------------------------------------------

describe("facebook oauth — refusals before any request", () => {
  it("names the missing environment variables instead of half-building a login URL", () => {
    const client = makeFacebookOAuthClient({
      logger: recordingLogger([]),
      appId: null,
      appSecret: null,
      redirectUri: null,
    });

    const error = (() => {
      try {
        client.buildAuthorizeUrl({ state: "abc" });
        return null;
      } catch (e: unknown) {
        return e as AppError;
      }
    })();

    expect(error?.code).toBe("CHANNEL_NOT_CONFIGURED");
    expect(error?.context).toMatchObject({
      missing: ["META_APP_ID", "META_APP_SECRET", "META_OAUTH_REDIRECT_URI"],
    });
    expect(error?.userMessage).toContain("META_APP_SECRET");
    // The other door must stay open in the message: a missing secret is not a
    // dead end while pasting a token still works.
    expect(error?.userMessage).toContain("User Access Token");
  });

  it("refuses to build a login URL without a CSRF state", () => {
    const { client } = harness([]);
    expect(() => client.buildAuthorizeUrl({ state: "  " })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses an empty user token before touching the network", async () => {
    const { client, calls } = harness([]);
    await expect(client.listAccounts({ userAccessToken: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "USER_TOKEN_MISSING" },
    });
    expect(calls).toEqual([]);
  });
});

describe("facebook oauth — Graph failures speak to the operator", () => {
  it("turns an expired token (code 190) into 'dán token mới'", async () => {
    const { client, lines } = harness([
      { status: 400, body: { error: { code: 190, type: "OAuthException", message: "expired" } } },
    ]);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(error.userMessage).toContain("hết hạn hoặc không hợp lệ");
    expect(error.userMessage).toContain("User Access Token");
    // The Graph code stays in the log context, for the developer.
    expect(error.context).toMatchObject({ graph_code: 190, step: "list_pages" });
    expectNoSecretsLogged(lines);
  });

  it("turns a missing permission into the list of scopes to grant", async () => {
    const { client } = harness([
      { status: 403, body: { error: { code: 200, type: "OAuthException", message: "perm" } } },
    ]);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(error.userMessage).toContain("pages_show_list");
    expect(error.userMessage).toContain("pages_manage_posts");
    expect(error.userMessage).toContain("pages_read_engagement");
  });

  it("does not reuse the publishing wording for a used authorization code", async () => {
    const { client } = harness([
      {
        status: 400,
        body: { error: { code: 100, error_subcode: 36009, message: "code was already used" } },
      },
    ]);

    const error = await expectAppError(client.exchangeCodeForUserToken({ code: "used-code" }));

    expect(error.userMessage).toContain("Mã uỷ quyền");
    expect(error.userMessage).not.toContain("bài đăng");
  });

  it("refuses an answer that is not the shape we agreed on", async () => {
    const { client } = harness([{ body: { data: [{ id: 42, name: "Shop" }] } }]);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(error.code).toBe("META_ERROR");
    expect(error.context).toMatchObject({ reason: "INVALID_ANSWER_SHAPE", step: "list_pages" });
  });

  it("refuses an HTML error page instead of guessing success", async () => {
    const { client } = harness([{ status: 500, text: "<html>Sorry</html>" }]);
    await expect(client.listAccounts({ userAccessToken: USER_TOKEN })).rejects.toMatchObject({
      code: "META_ERROR",
    });
  });

  it("never puts the echoed body of a GET in the error — the URL holds the token", async () => {
    // A proxy/WAF page that repeats the request line would otherwise write the
    // user token (and, on the OAuth exchange, the app secret) into the log.
    const { client, lines } = harness([
      {
        status: 502,
        text: `<html><body>Bad gateway for GET /v23.0/me/accounts?access_token=${USER_TOKEN}</body></html>`,
      },
    ]);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(JSON.stringify(error.context)).not.toContain(USER_TOKEN);
    expect(error.context).not.toHaveProperty("body_preview");
    expect(error.context).toMatchObject({ body_preview_omitted: expect.any(String) });
    expectNoSecretsLogged(lines);
  });

  it("refuses a partial list when Facebook says 'more' but gives no cursor", async () => {
    // Returning what we have would hand back 1 Page as if that were all of them.
    const { client } = harness([
      {
        body: {
          data: [{ id: "111", name: "Shop A", access_token: "page-token-a" }],
          paging: { next: "https://graph.facebook.com/next" },
        },
      },
    ]);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(error.code).toBe("META_ERROR");
    expect(error.context).toMatchObject({
      reason: "PAGING_CURSOR_MISSING",
      accounts_so_far: 1,
      retryable: true,
    });
    expect(error.userMessage).toContain("thiếu");
  });

  it("refuses rather than truncating when Facebook pages forever", async () => {
    const endless = Array.from({ length: MAX_PAGES_OF_PAGES }, (_, index) => ({
      body: {
        data: [{ id: `page-${index}`, name: `Shop ${index}`, access_token: `page-token-${index}` }],
        paging: { cursors: { after: `CURSOR-${index}` }, next: "https://graph.facebook.com/next" },
      },
    }));
    const { client, calls } = harness(endless);

    const error = await expectAppError(client.listAccounts({ userAccessToken: USER_TOKEN }));

    expect(error.context).toMatchObject({
      reason: "PAGING_LIMIT",
      max_pages: MAX_PAGES_OF_PAGES,
    });
    // Exactly the budget, not one request more.
    expect(calls).toHaveLength(MAX_PAGES_OF_PAGES);
  });

  it("refuses a token answer without an access_token", async () => {
    const { client } = harness([{ body: { token_type: "bearer" } }]);
    await expect(client.extendUserToken({ userAccessToken: USER_TOKEN })).rejects.toMatchObject({
      code: "META_ERROR",
      context: { reason: "INVALID_ANSWER_SHAPE", step: "extend_token" },
    });
  });
});

// --- Happy paths ------------------------------------------------------------

describe("facebook oauth — the login URL", () => {
  it("asks for exactly the three scopes this product needs", () => {
    const { client } = harness([]);
    const url = new URL(client.buildAuthorizeUrl({ state: "nonce-123" }));

    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("1640548543911378");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://mysp.example.com/api/channels/callback",
    );
    expect(url.searchParams.get("state")).toBe("nonce-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "pages_show_list,pages_manage_posts,pages_read_engagement",
    );
  });
});

describe("facebook oauth — tokens", () => {
  it("exchanges the code and immediately extends it to a long-lived token", async () => {
    const { client, calls, lines } = harness([
      { body: { access_token: USER_TOKEN, expires_in: 3600 } },
      { body: { access_token: LONG_TOKEN, expires_in: 5_184_000 } },
    ]);

    const token = await client.exchangeCodeForUserToken({ code: "the-code" });

    expect(token.userAccessToken).toBe(LONG_TOKEN);
    expect(token.extended).toBe(true);
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect(calls[0]).toContain("/v23.0/oauth/access_token?");
    expect(calls[0]).toContain("code=the-code");
    expect(calls[1]).toContain("grant_type=fb_exchange_token");
    expectNoSecretsLogged(lines);
  });

  it("without an app secret: uses the token as handed over, and says so", async () => {
    const { client, calls, lines } = harness([], { appSecret: null });

    const token = await client.extendUserToken({ userAccessToken: USER_TOKEN });

    expect(token).toMatchObject({ userAccessToken: USER_TOKEN, extended: false, expiresAt: null });
    // No request at all: there is nothing to exchange with.
    expect(calls).toEqual([]);
    const warn = lines.find((line) => line.level === "warn");
    expect(warn?.context).toMatchObject({ reason: "APP_SECRET_MISSING" });
    expectNoSecretsLogged(lines);
  });
});

describe("facebook oauth — listing Pages", () => {
  it("follows paging to the END and keeps every Page", async () => {
    const { client, calls, lines } = harness([
      {
        body: {
          data: [
            { id: "111", name: "Shop A", access_token: "page-token-a" },
            { id: "222", name: "Shop B", access_token: "page-token-b" },
          ],
          paging: { cursors: { after: "CURSOR-1" }, next: "https://graph.facebook.com/next" },
        },
      },
      {
        body: {
          data: [{ id: "333", name: "Shop C", access_token: "page-token-c" }],
          paging: { cursors: { after: "CURSOR-2" } },
        },
      },
    ]);

    const result = await client.listAccounts({ userAccessToken: USER_TOKEN });

    expect(result.accounts.map((account) => account.externalId)).toEqual(["111", "222", "333"]);
    expect(result.accounts[0]).toMatchObject({
      name: "Shop A",
      accessToken: "page-token-a",
      tokenExpiresAt: null,
    });
    expect(calls).toHaveLength(2);
    // The cursor is what we send back — no URL from the answer is followed.
    expect(calls[1]).toContain("after=CURSOR-1");
    expectNoSecretsLogged(lines);
  });

  it("reports a Page WITHOUT a token as skipped instead of saving it broken", async () => {
    const { client } = harness([
      {
        body: {
          data: [
            { id: "111", name: "Shop A", access_token: "page-token-a" },
            { id: "999", name: "Trang không quản lý" },
          ],
        },
      },
    ]);

    const result = await client.listAccounts({ userAccessToken: USER_TOKEN });

    expect(result.accounts.map((account) => account.externalId)).toEqual(["111"]);
    expect(result.skipped).toEqual(["999"]);
  });

  it("answers an empty list when the token manages nothing (the caller decides)", async () => {
    const { client } = harness([{ body: { data: [] } }]);
    expect(await client.listAccounts({ userAccessToken: USER_TOKEN })).toEqual({
      accounts: [],
      skipped: [],
    });
  });
});
