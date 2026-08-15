import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelConnectClient,
  ListRemoteChannelsResult,
  RemoteChannelAccount,
  UserAccessToken,
} from "@/core/ports/publisher";

import { DEFAULT_GRAPH_VERSION, makeGraphClient, type GraphClient } from "./graph-client";

/**
 * E5.1 — "Kết nối Fanpage" against Facebook Login + Graph API.
 *
 * Sources (developers.facebook.com):
 *   - Facebook Login manually building a login flow: the dialog lives on
 *     www.facebook.com/<version>/dialog/oauth, the exchange on
 *     graph.facebook.com/<version>/oauth/access_token;
 *   - Long-lived tokens: grant_type=fb_exchange_token gives ~60 days, and a
 *     Page token derived from a LONG-LIVED user token does not expire;
 *   - Pages: GET /me/accounts?fields=id,name,access_token, cursor-paginated.
 * PENDING(meta-live-test): verified against the documentation, not yet against
 * a real app — the first connect on a test Page confirms it.
 *
 * TWO DOORS, one client:
 *   - OAuth needs META_APP_ID + META_APP_SECRET + META_OAUTH_REDIRECT_URI;
 *   - pasting a User Access Token needs NOTHING (the token is the credential),
 *     which is why the app secret is optional here. Without it we simply cannot
 *     extend the token, and `extended: false` tells the caller to warn.
 *
 * SECRETS: tokens travel in query strings because Graph has no other way for a
 * GET. Nothing here ever logs a URL, a param map or a token — only `path`,
 * step names and Page ids.
 */

/** Exactly what this product needs: list Pages, post, read the Page's posts. */
export const FACEBOOK_CONNECT_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
] as const;

const AUTH_DIALOG_BASE = "https://www.facebook.com";
/** Pages per request; Meta caps it, the loop below follows `paging` regardless. */
const PAGE_LIMIT = 100;
/** Hard stop: 20 * 100 Pages is far past any real account, and a Graph that
 *  always answers `next` must not spin this loop forever. */
export const MAX_PAGES_OF_PAGES = 20;

export interface FacebookOAuthDeps {
  logger: Logger;
  /** META_APP_ID. Required by the OAuth door only. */
  appId?: string | null;
  /** META_APP_SECRET. Optional: without it, tokens are used as handed over. */
  appSecret?: string | null;
  /** META_OAUTH_REDIRECT_URI. Required by the OAuth door only. */
  redirectUri?: string | null;
  version?: string;
  /** Injection seam for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Pre-built transport (tests/scripts); otherwise one is made from fetchImpl. */
  graph?: GraphClient;
  authDialogBaseUrl?: string;
}

/** `{ access_token, token_type, expires_in }` — Meta's OAuth answer. */
const TokenAnswerSchema = z.object({
  access_token: z.string().trim().min(1),
  token_type: z.string().trim().min(1).optional(),
  /** Seconds. Absent for a token that does not expire. */
  expires_in: z.coerce.number().int().nonnegative().optional(),
});

/**
 * One entry of `/me/accounts`. `access_token` is OPTIONAL on purpose: a Page the
 * user can see but not manage comes back without one, and that must not blow up
 * the whole import (it is reported as `skipped`).
 */
const AccountSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  access_token: z.string().trim().min(1).optional(),
});

const AccountsAnswerSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z.object({ after: z.string().trim().min(1).optional() }).optional(),
      next: z.string().trim().min(1).optional(),
    })
    .optional(),
});

export function makeFacebookOAuthClient(deps: FacebookOAuthDeps): ChannelConnectClient {
  const version = (deps.version ?? DEFAULT_GRAPH_VERSION).trim() || DEFAULT_GRAPH_VERSION;
  const logger = deps.logger.child({ component: "facebook-oauth" });
  const graph =
    deps.graph ?? makeGraphClient({ logger: deps.logger, version, fetchImpl: deps.fetchImpl });
  const dialogBase = (deps.authDialogBaseUrl ?? AUTH_DIALOG_BASE).replace(/\/+$/, "");

  const appId = trim(deps.appId);
  const appSecret = trim(deps.appSecret);
  const redirectUri = trim(deps.redirectUri);

  /** The OAuth door refuses to start rather than send Facebook half a request. */
  function requireOAuthApp(): { appId: string; appSecret: string; redirectUri: string } {
    const missing = [
      appId.length === 0 ? "META_APP_ID" : null,
      appSecret.length === 0 ? "META_APP_SECRET" : null,
      redirectUri.length === 0 ? "META_OAUTH_REDIRECT_URI" : null,
    ].filter((name): name is string => name !== null);

    if (missing.length > 0) {
      throw new AppError("CHANNEL_NOT_CONFIGURED", {
        message: `Facebook Login is not configured: missing ${missing.join(", ")}`,
        userMessage: `Chưa cấu hình ứng dụng Facebook — thiếu biến môi trường: ${missing.join(", ")}. Trong lúc chờ, có thể dán User Access Token để nhập danh sách Trang.`,
        context: { scope: "meta-oauth", missing, reason: "APP_NOT_CONFIGURED" },
      });
    }
    return { appId, appSecret, redirectUri };
  }

  return {
    buildAuthorizeUrl(input): string {
      const state = trim(input?.state);
      if (state.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "buildAuthorizeUrl requires a CSRF state",
          userMessage: "Không tạo được phiên kết nối Facebook — hãy thử lại.",
          context: { reason: "STATE_MISSING" },
        });
      }
      const app = requireOAuthApp();

      const url = new URL(`${dialogBase}/${version}/dialog/oauth`);
      url.searchParams.set("client_id", app.appId);
      url.searchParams.set("redirect_uri", app.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", FACEBOOK_CONNECT_SCOPES.join(","));
      url.searchParams.set("response_type", "code");
      return url.toString();
    },

    async exchangeCodeForUserToken(input): Promise<UserAccessToken> {
      // --- Edge cases first --------------------------------------------------
      const code = trim(input?.code);
      if (code.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "exchangeCodeForUserToken requires the authorization code",
          userMessage: "Facebook không trả về mã uỷ quyền — hãy thử kết nối lại.",
          context: { reason: "CODE_MISSING" },
        });
      }
      const app = requireOAuthApp();

      let answer: Record<string, unknown>;
      try {
        answer = await graph.get({
          path: "oauth/access_token",
          params: {
            client_id: app.appId,
            client_secret: app.appSecret,
            redirect_uri: app.redirectUri,
            code,
          },
          context: { step: "exchange_code" },
        });
      } catch (error) {
        throw connectError("exchange_code", error);
      }

      const shortLived = parseToken(answer, "exchange_code");
      // The short-lived token is useless for us: Page tokens inherit its life.
      return extend(shortLived.token);
    },

    async extendUserToken(input): Promise<UserAccessToken> {
      const token = trim(input?.userAccessToken);
      if (token.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "extendUserToken requires a user access token",
          userMessage: "Thiếu User Access Token của Facebook — hãy dán token rồi thử lại.",
          context: { reason: "USER_TOKEN_MISSING" },
        });
      }
      return extend(token);
    },

    async listAccounts(input): Promise<ListRemoteChannelsResult> {
      const token = trim(input?.userAccessToken);
      if (token.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listAccounts requires a user access token",
          userMessage: "Thiếu User Access Token của Facebook — hãy dán token rồi thử lại.",
          context: { reason: "USER_TOKEN_MISSING" },
        });
      }

      const accounts: RemoteChannelAccount[] = [];
      const skipped: string[] = [];
      const seen = new Set<string>();
      let after: string | null = null;

      for (let page = 0; page < MAX_PAGES_OF_PAGES; page += 1) {
        let answer: Record<string, unknown>;
        try {
          answer = await graph.get({
            path: "me/accounts",
            params: {
              fields: "id,name,access_token",
              limit: String(PAGE_LIMIT),
              ...(after ? { after } : {}),
            },
            accessToken: token,
            context: { step: "list_pages", page_index: page },
          });
        } catch (error) {
          throw connectError("list_pages", error);
        }

        const parsed = AccountsAnswerSchema.safeParse(answer);
        if (!parsed.success) {
          throw invalidAnswer("list_pages", parsed.error.issues.map(issuePath));
        }

        for (const [index, raw] of parsed.data.data.entries()) {
          const account = AccountSchema.safeParse(raw);
          if (!account.success) {
            // A Page we cannot even name is a contract change on Meta's side,
            // not a Page to skip quietly.
            throw invalidAnswer(
              "list_pages",
              account.error.issues.map(issuePath),
              { page_index: page, item_index: index },
            );
          }
          if (!account.data.access_token) {
            skipped.push(account.data.id);
            continue;
          }
          if (seen.has(account.data.id)) continue;
          seen.add(account.data.id);
          accounts.push({
            externalId: account.data.id,
            name: account.data.name,
            accessToken: account.data.access_token,
            // A Page token minted from a long-lived user token does not expire;
            // Graph reports no expiry for it either way.
            tokenExpiresAt: null,
          });
        }

        // `next` present = there is more. The CURSOR is what we send back, so
        // no URL from the answer is ever followed blindly.
        const hasMore = Boolean(parsed.data.paging?.next);
        if (!hasMore) {
          logger.debug("Listed Facebook Pages", {
            step: "list_pages",
            pages_fetched: page + 1,
            accounts: accounts.length,
            skipped: skipped.length,
          });
          return { accounts, skipped };
        }

        const nextCursor = parsed.data.paging?.cursors?.after;
        if (!nextCursor) {
          // "There is more, but here is no cursor" leaves us unable to ask for
          // the rest. Returning what we have would hand back a PARTIAL list
          // that looks complete — the operator would tick 8 Pages out of 12 and
          // never know (business rule 5).
          throw new AppError("META_ERROR", {
            message: "Facebook reported more Pages but returned no `after` cursor",
            userMessage:
              "Facebook chưa trả hết danh sách Trang (thiếu con trỏ phân trang) — danh sách có thể bị thiếu, hãy thử lại sau ít phút.",
            context: {
              step: "list_pages",
              reason: "PAGING_CURSOR_MISSING",
              page_index: page,
              accounts_so_far: accounts.length,
              retryable: true,
            },
          });
        }
        after = nextCursor;
      }

      // Ran out of loop budget: report what we have would be a silent truncation.
      throw new AppError("META_ERROR", {
        message: `Facebook kept paginating past ${MAX_PAGES_OF_PAGES} pages of Pages`,
        userMessage:
          "Không lấy được hết danh sách Trang từ Facebook — hãy thử lại sau ít phút.",
        context: {
          step: "list_pages",
          reason: "PAGING_LIMIT",
          max_pages: MAX_PAGES_OF_PAGES,
          retryable: true,
        },
      });
    },
  };

  /**
   * Short-lived -> ~60 days. Without an app secret the token is returned as it
   * came, with `extended: false` — the caller warns instead of failing, because
   * an operator with a working token must not be blocked on a missing secret.
   */
  async function extend(token: string): Promise<UserAccessToken> {
    if (appId.length === 0 || appSecret.length === 0) {
      logger.warn("No app secret configured — the user token is used as handed over", {
        step: "extend_token",
        reason: "APP_SECRET_MISSING",
        missing: appId.length === 0 ? ["META_APP_ID", "META_APP_SECRET"] : ["META_APP_SECRET"],
      });
      return { userAccessToken: token, expiresAt: null, extended: false };
    }

    let answer: Record<string, unknown>;
    try {
      answer = await graph.get({
        path: "oauth/access_token",
        params: {
          grant_type: "fb_exchange_token",
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: token,
        },
        context: { step: "extend_token" },
      });
    } catch (error) {
      throw connectError("extend_token", error);
    }

    const parsed = parseToken(answer, "extend_token");
    return {
      userAccessToken: parsed.token,
      expiresAt: parsed.expiresInSec === null ? null : new Date(Date.now() + parsed.expiresInSec * 1000),
      extended: true,
    };
  }

  /** Never trust the answer shape: a token field that is not there is a bug we must see. */
  function parseToken(
    answer: Record<string, unknown>,
    step: string,
  ): { token: string; expiresInSec: number | null } {
    const parsed = TokenAnswerSchema.safeParse(answer);
    if (!parsed.success) throw invalidAnswer(step, parsed.error.issues.map(issuePath));
    return {
      token: parsed.data.access_token,
      expiresInSec: parsed.data.expires_in ?? null,
    };
  }
}

// --- error mapping ----------------------------------------------------------

/** Per-step fallback, used when the Graph error carries no reason we know. */
const STEP_MESSAGES: Record<string, string> = {
  exchange_code: "Không đổi được mã uỷ quyền của Facebook — hãy bấm “Kết nối Facebook” lại.",
  extend_token: "Không gia hạn được token Facebook — hãy lấy User Access Token mới rồi thử lại.",
  list_pages: "Không lấy được danh sách Trang từ Facebook — hãy thử lại sau ít phút.",
};

/**
 * Re-words a Graph failure for the CONNECT flow. The publish-oriented wording of
 * graph-error-map ("Facebook từ chối dữ liệu bài đăng") would send an operator
 * looking at a post that does not exist yet.
 *
 * The original code, graph code/subcode and fbtrace_id stay in `context`, and
 * the original error stays as `cause` — the transport already logged it, so this
 * only wraps and rethrows (no second log line for one incident).
 */
function connectError(step: string, error: unknown): AppError {
  if (!AppError.is(error)) {
    return new AppError("META_ERROR", {
      message: `Facebook connect step ${step} failed`,
      userMessage: STEP_MESSAGES[step] ?? STEP_MESSAGES.list_pages,
      context: { step, reason: "UNKNOWN" },
      cause: error,
    });
  }

  const reason = typeof error.context.reason === "string" ? error.context.reason : "UNKNOWN";
  const userMessage = ((): string => {
    switch (reason) {
      case "TOKEN_INVALID":
      case "APP_REMOVED":
      case "HTTP_UNAUTHORIZED":
        return "Token Facebook đã hết hạn hoặc không hợp lệ — hãy lấy User Access Token mới rồi dán lại.";
      case "PERMISSION_DENIED":
        return `Token Facebook thiếu quyền quản lý Trang (${FACEBOOK_CONNECT_SCOPES.join(", ")}) — hãy cấp đủ quyền rồi lấy token mới.`;
      case "RATE_LIMITED":
      case "HTTP_RATE_LIMITED":
        return "Facebook đang giới hạn tần suất truy cập — hãy thử lại sau ít phút.";
      case "INVALID_PARAMETER":
        return step === "exchange_code"
          ? "Mã uỷ quyền của Facebook không dùng được (đã hết hạn hoặc đã dùng) — hãy bấm “Kết nối Facebook” lại."
          : "Facebook từ chối yêu cầu kết nối — hãy lấy User Access Token mới rồi thử lại.";
      default:
        return STEP_MESSAGES[step] ?? STEP_MESSAGES.list_pages;
    }
  })();

  return new AppError(error.code, {
    message: `Facebook connect step ${step} failed: ${error.message}`,
    userMessage,
    context: { ...error.context, step },
    cause: error,
  });
}

function invalidAnswer(
  step: string,
  issues: string[],
  extra: Record<string, unknown> = {},
): AppError {
  return new AppError("META_ERROR", {
    message: `Facebook answered ${step} with an unexpected shape`,
    userMessage: "Facebook trả về dữ liệu không đúng định dạng — hãy thử lại sau ít phút.",
    // Paths only: a value here could be a token.
    context: { ...extra, step, reason: "INVALID_ANSWER_SHAPE", issues, retryable: false },
  });
}

function issuePath(issue: { path: PropertyKey[] }): string {
  return issue.path.map((part) => String(part)).join(".") || "(root)";
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
