import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type {
  GoogleOAuthClient,
  GoogleOAuthTokens,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

/**
 * E2 — "Kết nối Google Drive": the OAuth 2.0 web-server flow of Google Identity,
 * so a tenant grants THIS app read access to their own Drive/Sheets.
 *
 * Sources (developers.google.com/identity/protocols/oauth2/web-server):
 *   - consent screen: accounts.google.com/o/oauth2/v2/auth (built by
 *     `generateAuthUrl`), token exchange: oauth2.googleapis.com/token,
 *     revoke: oauth2.googleapis.com/revoke — all three inside google-auth-library;
 *   - `access_type=offline` + `prompt=consent` is what makes Google return a
 *     REFRESH token every time. Without `prompt=consent`, a returning user gets
 *     an access token only, and the connection would die in one hour.
 *
 * SECRETS: the client secret and the refresh token pass through this file. They
 * are never logged, never put in an AppError context, never returned other than
 * as `GoogleOAuthTokens.refreshToken`.
 */

/**
 * Read-only Drive + Sheets, plus the identity of the account so the screen can
 * say WHICH Google account is connected. Nothing here can write to the tenant's
 * Drive — that is a property of the scopes, not of our code.
 */
export const GOOGLE_DRIVE_CONNECT_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "openid",
  "email",
] as const;

/** OAuth2 client type, taken from googleapis so no extra package is imported. */
export type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export interface GoogleOAuthAppCredentials {
  readonly clientId?: string | null;
  readonly clientSecret?: string | null;
  readonly redirectUri?: string | null;
}

export interface GoogleOAuthClientDeps {
  logger: Logger;
  /**
   * Read on FIRST USE, not at construction: a web/worker process must boot
   * without a Google OAuth app, and the failure must land on the operator
   * pressing the button, naming the variable.
   */
  readCredentials: () => GoogleOAuthAppCredentials;
  /** Injection seam for tests; production builds a real OAuth2 client. */
  makeClient?: (credentials: Required<GoogleOAuthAppCredentials>) => GoogleOAuth2Client;
}

/** What `getToken` gives back. Everything is optional in the wire format. */
const TokenResponseSchema = z.object({
  refresh_token: z.string().trim().min(1).nullish(),
  access_token: z.string().trim().min(1).nullish(),
  /** Space-delimited list of the scopes Google actually granted. */
  scope: z.string().trim().nullish(),
  expiry_date: z.number().nullish(),
});

const UserInfoSchema = z.object({
  email: z.string().trim().min(1),
  verified_email: z.boolean().nullish(),
});

export function makeGoogleOAuthClient(deps: GoogleOAuthClientDeps): GoogleOAuthClient {
  const logger = deps.logger.child({ component: "google-oauth" });

  /** Refuses to start a flow we cannot finish, naming the missing variables. */
  function client(): GoogleOAuth2Client {
    const credentials = deps.readCredentials();
    const clientId = trim(credentials?.clientId);
    const clientSecret = trim(credentials?.clientSecret);
    const redirectUri = trim(credentials?.redirectUri);

    const missing = [
      clientId.length === 0 ? "GOOGLE_CLIENT_ID" : null,
      clientSecret.length === 0 ? "GOOGLE_CLIENT_SECRET" : null,
      redirectUri.length === 0 ? "GOOGLE_OAUTH_REDIRECT_URI" : null,
    ].filter((name): name is string => name !== null);

    if (missing.length > 0) {
      throw new AppError("GOOGLE_OAUTH_NOT_CONFIGURED", {
        message: `Google OAuth is not configured: missing ${missing.join(", ")}`,
        userMessage: `Chưa cấu hình ứng dụng Google OAuth — thiếu biến môi trường: ${missing.join(", ")}. Trong lúc chờ, vẫn có thể nhập thủ công link thư mục Drive và bảng Sheet.`,
        context: { scope: "google-oauth", missing, reason: "APP_NOT_CONFIGURED" },
      });
    }

    const resolved = { clientId, clientSecret, redirectUri };
    if (deps.makeClient) return deps.makeClient(resolved);
    return new google.auth.OAuth2(resolved);
  }

  return {
    buildAuthorizeUrl(input): string {
      // --- Edge cases first --------------------------------------------------
      const state = trim(input?.state);
      if (state.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "buildAuthorizeUrl requires a CSRF state",
          userMessage: "Không tạo được phiên kết nối Google — hãy thử lại.",
          context: { reason: "STATE_MISSING" },
        });
      }

      return client().generateAuthUrl({
        // offline + consent = a refresh token on EVERY consent, including the
        // second one. This pair is the whole reason the connection survives.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: true,
        scope: [...GOOGLE_DRIVE_CONNECT_SCOPES],
        state,
      });
    },

    async exchangeCode(input): Promise<GoogleOAuthTokens> {
      const code = trim(input?.code);
      if (code.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "exchangeCode requires the authorization code",
          userMessage: "Google không trả về mã uỷ quyền — hãy thử kết nối lại.",
          context: { reason: "CODE_MISSING" },
        });
      }

      const oauth = client();
      let rawTokens: unknown;
      try {
        const answer = await oauth.getToken(code);
        rawTokens = answer?.tokens;
      } catch (error) {
        throw oauthError("exchange_code", error);
      }

      const parsed = TokenResponseSchema.safeParse(rawTokens ?? {});
      if (!parsed.success) {
        throw invalidAnswer("exchange_code", parsed.error.issues.map(issuePath));
      }

      const refreshToken = trim(parsed.data.refresh_token);
      const accessToken = trim(parsed.data.access_token);
      if (accessToken.length === 0) {
        // No access token means we cannot even read the account's e-mail, so
        // the connection would be saved without knowing whose Drive it is.
        throw invalidAnswer("exchange_code", ["access_token"]);
      }

      oauth.setCredentials({
        access_token: accessToken,
        ...(refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
      });

      let rawUserInfo: unknown;
      try {
        const answer = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
        rawUserInfo = answer?.data;
      } catch (error) {
        throw oauthError("read_userinfo", error);
      }

      const userInfo = UserInfoSchema.safeParse(rawUserInfo);
      if (!userInfo.success) {
        throw invalidAnswer("read_userinfo", userInfo.error.issues.map(issuePath));
      }

      const scopes = splitScopes(parsed.data.scope);
      logger.info("Google consent exchanged", {
        step: "exchange_code",
        // The e-mail is operational data the screen shows anyway; the tokens
        // are NOT here, and never will be.
        google_email: userInfo.data.email,
        scopes,
        has_refresh_token: refreshToken.length > 0,
      });

      // An empty refresh token is reported as such; the usecase decides that it
      // is fatal (it is), and says so with the right code.
      return { refreshToken, email: userInfo.data.email, scopes };
    },

    async revoke(input): Promise<void> {
      const refreshToken = trim(input?.refreshToken);
      if (refreshToken.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "revoke requires a refresh token",
          userMessage: "Không có thông tin kết nối Google để thu hồi.",
          context: { reason: "REFRESH_TOKEN_MISSING" },
        });
      }

      try {
        await client().revokeToken(refreshToken);
      } catch (error) {
        throw oauthError("revoke", error);
      }
      logger.info("Google refresh token revoked", { step: "revoke" });
    },
  };
}

// --- error mapping ----------------------------------------------------------

/**
 * Google's OAuth error identifier, wherever this version of the library puts it.
 * Never looks at the message text: that is localised and it changes.
 */
export function googleOAuthErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    response?: { data?: { error?: unknown; error_description?: unknown } };
    // google-auth-library throws GaxiosError, but a refresh failure surfaces as
    // a plain Error whose `message` is the JSON body on some paths.
    data?: { error?: unknown };
    error?: unknown;
  };
  const raw =
    candidate.response?.data?.error ?? candidate.data?.error ?? candidate.error;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  // GaxiosError nests the original in `error.error` as an object sometimes.
  if (raw && typeof raw === "object") {
    const nested = (raw as { message?: unknown; status?: unknown }).status;
    if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  }
  return null;
}

/**
 * The two identifiers that mean "this refresh token is dead": the grant was
 * revoked/expired (`invalid_grant`), or the app was removed from the account
 * (`unauthorized_client`). Both need a human to press "Kết nối lại" — nothing
 * a retry can fix.
 */
export function isRevokedGrant(error: unknown): boolean {
  const code = googleOAuthErrorCode(error);
  return code === "invalid_grant" || code === "unauthorized_client";
}

/** HTTP status of a googleapis/gaxios error, whichever shape it throws. */
export function googleHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

const STEP_MESSAGES: Record<string, string> = {
  exchange_code: "Không đổi được mã uỷ quyền của Google — hãy bấm “Kết nối Google Drive” lại.",
  read_userinfo: "Không đọc được thông tin tài khoản Google — hãy thử kết nối lại.",
  revoke: "Không thu hồi được quyền truy cập tại Google.",
};

function oauthError(step: string, error: unknown): AppError {
  const oauthCode = googleOAuthErrorCode(error);
  const status = googleHttpStatus(error);
  // Never the raw cause message in `userMessage`: it can carry the client id.
  const context = { step, reason: oauthCode ?? "UNKNOWN", http_status: status };

  if (oauthCode === "invalid_client") {
    return new AppError("GOOGLE_OAUTH_NOT_CONFIGURED", {
      message: `Google rejected the OAuth app credentials during ${step}`,
      userMessage:
        "Google từ chối thông tin ứng dụng OAuth (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Vui lòng liên hệ quản trị viên.",
      context,
      cause: error,
    });
  }

  if (isRevokedGrant(error)) {
    return new AppError("GOOGLE_AUTH_EXPIRED", {
      message: `Google rejected the grant during ${step}`,
      context,
      cause: error,
    });
  }

  if (oauthCode === "invalid_request" || status === 400) {
    return new AppError("INVALID_INPUT", {
      message: `Google refused the ${step} request`,
      userMessage: STEP_MESSAGES[step] ?? STEP_MESSAGES.exchange_code,
      context,
      cause: error,
    });
  }

  return new AppError("DRIVE_ERROR", {
    message: `Google OAuth step ${step} failed`,
    userMessage: STEP_MESSAGES[step] ?? STEP_MESSAGES.exchange_code,
    context: { ...context, retryable: true },
    cause: error,
  });
}

function invalidAnswer(step: string, issues: string[]): AppError {
  return new AppError("DRIVE_ERROR", {
    message: `Google answered ${step} with an unexpected shape`,
    userMessage: "Google trả về dữ liệu không đúng định dạng — hãy thử lại sau ít phút.",
    // Paths only: a value here could be a token.
    context: { step, reason: "INVALID_ANSWER_SHAPE", issues, retryable: false },
  });
}

function issuePath(issue: { path: PropertyKey[] }): string {
  return issue.path.map((part) => String(part)).join(".") || "(root)";
}

function splitScopes(raw: string | null | undefined): readonly string[] {
  if (typeof raw !== "string") return [];
  return Array.from(new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean)));
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
