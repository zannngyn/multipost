import { google } from "googleapis";

import { AppError } from "@/core/domain/errors";
import type { GoogleAuthCache, GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

import {
  googleHttpStatus,
  isRevokedGrant,
  type GoogleOAuth2Client,
  type GoogleOAuthAppCredentials,
} from "./google-oauth";
import type { GoogleAuthClient } from "./service-account";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * WHICH Google identity reads a given tenant's Drive/Sheets (E2).
 *
 * Two modes, decided per tenant on first use:
 *   - the tenant CONNECTED a Google account -> their own OAuth refresh token;
 *   - nobody connected anything            -> the Service Account, exactly as
 *     before this feature existed. A tenant that never presses the button must
 *     not notice any change.
 *
 * THE DANGEROUS FAILURE, and why this file exists: a revoked refresh token
 * makes Drive answer "nothing" just as convincingly as an empty folder, and the
 * catalog sync reads "no file" as "everything was deleted". So a rejected grant
 * is turned into GOOGLE_AUTH_EXPIRED *before* any listing runs, and the
 * integration row is parked in `error` so the screen asks for a reconnect.
 */

/** Either identity is accepted by `google.drive()` / `google.sheets()`. */
export type GoogleApiAuth = GoogleAuthClient | GoogleOAuth2Client;

export interface TenantGoogleAuth extends GoogleAuthCache {
  /** Ready-to-use client. Throws GOOGLE_AUTH_EXPIRED when the grant is dead. */
  forTenant(tenantId: TenantId): Promise<GoogleApiAuth>;
  /**
   * A Drive/Sheets call failed mid-flight. Returns the AppError to throw when
   * it was an AUTH failure of a connected tenant (and parks the integration in
   * `error`), or null when the caller should keep its own mapping — a Service
   * Account 403 is a sharing problem, not an expired connection.
   */
  reportAuthFailure(tenantId: TenantId, error: unknown): Promise<AppError | null>;
}

type AuthMode = "oauth" | "service_account";

interface CacheEntry {
  readonly mode: AuthMode;
  readonly auth: GoogleApiAuth;
  /** Epoch ms after which the entry is re-read from the database. */
  readonly expiresAt: number;
}

/**
 * How long a resolved identity may be reused before the config is read again.
 *
 * `invalidate()` only reaches the process that called it, and the worker is a
 * DIFFERENT process: without an expiry, a tenant who disconnects (or reconnects
 * with another account) on the web keeps syncing under the OLD client in the
 * worker until somebody restarts it. Sixty seconds bounds that window with one
 * extra DB read per tenant per minute — a Redis pub/sub invalidation is the
 * proper fix and is a separate ticket.
 */
export const AUTH_CACHE_TTL_MS = 60_000;

export interface TenantGoogleAuthDeps {
  logger: Logger;
  oauth: GoogleOAuthRepo;
  /** Read on first use so a process boots without a Google OAuth app. */
  readCredentials: () => GoogleOAuthAppCredentials;
  /** Service Account fallback, built lazily by the composition root. */
  serviceAccountAuth: () => GoogleAuthClient;
  /** Injection seam for tests; production builds a real OAuth2 client. */
  makeOAuthClient?: (credentials: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) => GoogleOAuth2Client;
  /** Injection seam for the cache TTL. Defaults to the wall clock. */
  nowMs?: () => number;
}

export function makeTenantGoogleAuth(deps: TenantGoogleAuthDeps): TenantGoogleAuth {
  /**
   * One client per tenant per process, dropped on connect/disconnect AND after
   * AUTH_CACHE_TTL_MS — see the constant for why the TTL is not optional.
   */
  const cache = new Map<string, CacheEntry>();
  let serviceAccount: GoogleAuthClient | null = null;
  const nowMs = deps.nowMs ?? (() => Date.now());

  function remember(tenantId: TenantId, entry: Omit<CacheEntry, "expiresAt">): CacheEntry {
    const stored: CacheEntry = { ...entry, expiresAt: nowMs() + AUTH_CACHE_TTL_MS };
    cache.set(tenantId, stored);
    return stored;
  }

  function fallback(tenantId: TenantId): CacheEntry {
    // Built once per process: the JWT client is stateless across tenants and
    // parsing the key file on every listing would be pure waste. The TTL still
    // applies to the tenant ENTRY: a tenant that connects an account elsewhere
    // must stop falling back to the Service Account within the minute.
    if (!serviceAccount) serviceAccount = deps.serviceAccountAuth();
    return remember(tenantId, { mode: "service_account", auth: serviceAccount });
  }

  function buildOAuthClient(tenantId: TenantId, refreshToken: string): GoogleOAuth2Client {
    const credentials = deps.readCredentials();
    const clientId = trim(credentials?.clientId);
    const clientSecret = trim(credentials?.clientSecret);
    const missing = [
      clientId.length === 0 ? "GOOGLE_CLIENT_ID" : null,
      clientSecret.length === 0 ? "GOOGLE_CLIENT_SECRET" : null,
    ].filter((name): name is string => name !== null);

    if (missing.length > 0) {
      // The tenant DID connect, but the deployment lost the app credentials —
      // refusing loudly beats silently reading their Drive as somebody else.
      throw new AppError("GOOGLE_OAUTH_NOT_CONFIGURED", {
        message: `Cannot use the tenant's Google connection: missing ${missing.join(", ")}`,
        userMessage: `Chưa cấu hình ứng dụng Google OAuth — thiếu biến môi trường: ${missing.join(", ")}. Vui lòng liên hệ quản trị viên.`,
        context: { tenant_id: tenantId, scope: "google-oauth", missing, reason: "APP_NOT_CONFIGURED" },
      });
    }

    if (deps.makeOAuthClient) {
      return deps.makeOAuthClient({ clientId, clientSecret, refreshToken });
    }
    const client = new google.auth.OAuth2({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  async function markExpired(tenantId: TenantId, reason: string, error: unknown): Promise<AppError> {
    cache.delete(tenantId);
    try {
      await deps.oauth.markConnectionExpired(tenantId, reason);
    } catch (markError) {
      // Logged with context, never rethrown OVER the original: losing the real
      // reason to a bookkeeping failure is how "vì sao bài này không lên"
      // becomes unanswerable.
      deps.logger.error("Could not park the Google integration in `error`", {
        tenant_id: tenantId,
        reason: "MARK_EXPIRED_FAILED",
        err: AppError.from(markError, "DB_ERROR", { tenant_id: tenantId }),
      });
    }

    return new AppError("GOOGLE_AUTH_EXPIRED", {
      message: "Google rejected the tenant's refresh token",
      context: { tenant_id: tenantId, reason, provider: "google" },
      cause: error,
    });
  }

  return {
    invalidate(tenantId: TenantId): void {
      const key = normalizeTenantId(tenantId);
      if (key.length === 0) return;
      cache.delete(key);
    },

    async forTenant(tenantId: TenantId): Promise<GoogleApiAuth> {
      // --- Edge cases first --------------------------------------------------
      const key = normalizeTenantId(tenantId);
      if (key.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Resolving Google auth requires a tenant id",
          userMessage: "Mã đơn vị (tenant) không hợp lệ.",
          context: { tenant_id: null, operation: "googleAuth.forTenant" },
        });
      }

      const cached = cache.get(key);
      // An expired entry is DELETED, not merely ignored: a tenant nobody syncs
      // any more must not keep a token client alive in the map.
      if (cached && cached.expiresAt > nowMs()) return cached.auth;
      if (cached) cache.delete(key);

      const refreshToken = await deps.oauth.findRefreshToken(key);
      if (!refreshToken) {
        // Not an error: this is every tenant that has not connected yet.
        deps.logger.debug("No Google connection for this tenant — using the Service Account", {
          tenant_id: key,
          auth_mode: "service_account",
        });
        return fallback(key).auth;
      }

      const client = buildOAuthClient(key, refreshToken);

      // Refresh NOW rather than on the first listing: a dead grant must become
      // GOOGLE_AUTH_EXPIRED before anything can mistake it for an empty folder.
      try {
        const token = await client.getAccessToken();
        if (!token?.token) {
          throw await markExpired(key, "ACCESS_TOKEN_EMPTY", null);
        }
      } catch (error) {
        if (AppError.is(error)) throw error;
        if (isRevokedGrant(error)) throw await markExpired(key, "REFRESH_REJECTED", error);
        // A network blip is NOT a revoked connection: do not park the row.
        throw new AppError("DRIVE_ERROR", {
          message: "Could not refresh the tenant's Google access token",
          userMessage: "Không kết nối được tới Google. Vui lòng thử lại sau ít phút.",
          context: {
            tenant_id: key,
            reason: "TOKEN_REFRESH_FAILED",
            http_status: googleHttpStatus(error),
            retryable: true,
          },
          cause: error,
        });
      }

      deps.logger.debug("Using the tenant's own Google connection", {
        tenant_id: key,
        auth_mode: "oauth",
      });
      remember(key, { mode: "oauth", auth: client });
      return client;
    },

    async reportAuthFailure(tenantId: TenantId, error: unknown): Promise<AppError | null> {
      const key = normalizeTenantId(tenantId);
      if (key.length === 0) return null;
      // Only a CONNECTED tenant can have an expired connection. On the Service
      // Account a 401/403 means the folder was un-shared — a different story
      // with a different fix, and the caller already words it correctly.
      if (cache.get(key)?.mode !== "oauth") return null;

      const status = googleHttpStatus(error);
      if (!isRevokedGrant(error) && status !== 401) return null;

      return markExpired(key, isRevokedGrant(error) ? "REFRESH_REJECTED" : "HTTP_UNAUTHORIZED", error);
    },
  };
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
