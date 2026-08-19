import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type {
  GoogleAuthCache,
  GoogleDriveBrowser,
  GoogleOAuthClient,
  GoogleOAuthConnection,
  GoogleOAuthRepo,
  GoogleSourceAccessState,
} from "@/core/ports/google-oauth";
import type { Clock, Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import { checkAndRecordSourceAccess } from "./check-google-source-access";
import { resolveActorUserId } from "./resolve-actor";

/**
 * E2 — "Kết nối Google Drive" on the sync screen: the tenant grants this app
 * read access to THEIR Drive/Sheets, so an operator no longer has to paste a
 * folder id and beg someone to share it with a service account.
 *
 * Same shape as the Facebook connect flow (E5.1): start -> Google -> callback,
 * with the CSRF nonce living in an httpOnly cookie the route owns.
 *
 * SECRETS: the refresh token passes through `completeGoogleConnect` and stops
 * at the repo (which seals it). No view type here has a token field, and no
 * log line below carries one — not even a prefix of it.
 */

export interface StartGoogleConnectInput {
  readonly tenantId: string;
}

export interface StartGoogleConnectResult {
  readonly tenantId: string;
  readonly state: string;
  readonly authorizeUrl: string;
}

export interface CompleteGoogleConnectInput {
  /** Read from the state cookie, NEVER from the query string. */
  readonly tenantId: string;
  readonly code: string;
  /** `state` as Google echoed it back. */
  readonly state: string;
  /** `state` as we minted it, out of the httpOnly cookie. */
  readonly expectedState: string;
  readonly actorEmail?: string | null;
}

export interface GoogleConnectionInput {
  readonly tenantId: string;
  readonly actorEmail?: string | null;
}

/**
 * Exactly the three shapes the sync screen renders. `expired` is deliberately
 * NOT folded into `not_connected`: "kết nối lại" and "kết nối lần đầu" read the
 * same to a machine and completely differently to the person reading the screen.
 */
export type GoogleConnectionView =
  | { readonly state: "not_connected" }
  | {
      readonly state: "connected";
      readonly email: string;
      readonly connectedAt: string;
      readonly scopes: readonly string[];
      /**
       * Whether THIS account can read the source the tenant is configured with.
       * Connected does not mean usable: an account that sees the sheet but not
       * the photo folder makes Drive answer "0 file", which the sync would read
       * as "everything was deleted" if it did not have its own safety net.
       * Stored at connect/source-save time and read back here — never re-probed
       * on a screen that polls.
       */
      readonly sourceAccess: GoogleSourceAccessState;
    }
  | {
      readonly state: "expired";
      readonly email: string;
      readonly connectedAt: string;
      readonly reason: "GOOGLE_AUTH_EXPIRED";
    };

export interface ConnectGoogleDriveDeps {
  oauth: GoogleOAuthRepo;
  client: GoogleOAuthClient;
  /** Dropped on every connect/disconnect so no call reuses the old account. */
  authCache: GoogleAuthCache;
  /** Reads the source the tenant already has, to check it against the NEW account. */
  catalogConfig: CatalogConfigRepo;
  /** Probes that source with the new account. Never blocks the connect. */
  browser: GoogleDriveBrowser;
  clock: Clock;
  logger: Logger;
  /** CSPRNG hex, injected: core must not know node:crypto exists. */
  newState: () => string;
  users?: UserRepo;
}

export interface ConnectGoogleDrive {
  startGoogleConnect(input: StartGoogleConnectInput): Promise<StartGoogleConnectResult>;
  completeGoogleConnect(input: CompleteGoogleConnectInput): Promise<GoogleConnectionView>;
  getGoogleConnection(input: GoogleConnectionInput): Promise<GoogleConnectionView>;
  disconnectGoogle(input: GoogleConnectionInput): Promise<GoogleConnectionView>;
}

export function makeConnectGoogleDrive(deps: ConnectGoogleDriveDeps): ConnectGoogleDrive {
  return {
    async startGoogleConnect(input) {
      const tenantId = requireTenant(input?.tenantId, "startGoogleConnect");
      const state = str(deps.newState());
      if (state.length < 16) {
        // A weak/empty state would make the callback's CSRF check theatre.
        throw new AppError("INTERNAL", {
          message: "The generated OAuth state is too short to be a CSRF nonce",
          context: { tenant_id: tenantId, state_length: state.length },
        });
      }

      // Throws GOOGLE_OAUTH_NOT_CONFIGURED naming the missing variables, so the
      // operator gets a readable body instead of a redirect into a Google 400.
      const authorizeUrl = deps.client.buildAuthorizeUrl({ state });

      deps.logger.info("Google Drive connect started", {
        tenant_id: tenantId,
        step: "authorize",
      });
      return { tenantId, state, authorizeUrl };
    },

    async completeGoogleConnect(input) {
      // --- Edge cases first: CSRF before anything touches the network -------
      const tenantId = requireTenant(input?.tenantId, "completeGoogleConnect");
      const expectedState = str(input?.expectedState);
      const state = str(input?.state);
      // GOOGLE_CONNECT_STATE_INVALID, not INVALID_INPUT: the callback redirects
      // with the CODE as `reason`, so a generic code would reach the operator as
      // "dữ liệu gửi lên không hợp lệ" — true for a machine, useless to someone
      // whose cookie was blocked.
      if (expectedState.length === 0) {
        throw new AppError("GOOGLE_CONNECT_STATE_INVALID", {
          message: "The Google OAuth state cookie is missing or expired",
          userMessage:
            "Phiên kết nối Google đã hết hạn hoặc bị chặn cookie — hãy bấm “Kết nối Google Drive” lại.",
          context: { tenant_id: tenantId, reason: "STATE_MISSING" },
        });
      }
      if (state.length === 0 || !constantTimeEquals(state, expectedState)) {
        throw new AppError("GOOGLE_CONNECT_STATE_INVALID", {
          message: "The Google OAuth state does not match the one we issued",
          userMessage:
            "Phiên kết nối Google không hợp lệ (state không khớp) — hãy bấm “Kết nối Google Drive” lại.",
          context: { tenant_id: tenantId, reason: "STATE_MISMATCH" },
        });
      }

      const code = str(input?.code);
      if (code.length === 0) {
        throw new AppError("GOOGLE_CONNECT_STATE_INVALID", {
          message: "Google returned no authorization code",
          userMessage: "Google không trả về mã uỷ quyền — hãy thử kết nối lại.",
          context: { tenant_id: tenantId, reason: "CODE_MISSING" },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId });
      const actorEmail = str(input?.actorEmail).toLowerCase() || null;

      const tokens = await deps.client.exchangeCode({ code });
      const refreshToken = str(tokens?.refreshToken);
      if (refreshToken.length === 0) {
        // Without a refresh token the connection dies in an hour and the sync
        // starts failing at 3 a.m. Refuse now, while somebody is watching.
        throw new AppError("GOOGLE_AUTH_EXPIRED", {
          message: "Google returned no refresh token for this consent",
          userMessage:
            "Google không cấp quyền dài hạn cho lần kết nối này. Hãy gỡ quyền của ứng dụng tại myaccount.google.com/permissions rồi kết nối lại.",
          context: { tenant_id: tenantId, reason: "REFRESH_TOKEN_MISSING" },
        });
      }

      const email = str(tokens?.email);
      const scopes = normaliseScopes(tokens?.scopes);
      const connectedAt = new Date(deps.clock.nowMs()).toISOString();
      const actorUserId = await resolveActorUserId({ users: deps.users }, tenantId, { actorEmail }, log);

      await deps.oauth.saveConnection({
        tenantId,
        refreshToken,
        email,
        scopes,
        connectedAt,
        actorUserId,
        actorEmail,
      });
      // The previous account's client must not survive a reconnect — and the
      // check below MUST run on the new one, so this comes before it.
      deps.authCache.invalidate(tenantId);

      // Connecting an account and choosing a source are two separate actions,
      // so a tenant that already had a source may now be reading it with an
      // identity that cannot see it. Recorded, NOT blocked: "kết nối xong rồi
      // chọn nguồn" is the normal first-time flow, and refusing it would leave
      // the operator unable to connect at all.
      const sourceAccess = await checkAndRecordSourceAccess(deps, tenantId, log);

      log.info("Google Drive connected", {
        step: "callback",
        google_email: email,
        scopes,
        actor_email: actorEmail,
        source_access: sourceAccess,
      });

      return { state: "connected", email, connectedAt, scopes, sourceAccess };
    },

    async getGoogleConnection(input) {
      const tenantId = requireTenant(input?.tenantId, "getGoogleConnection");
      const connection = await deps.oauth.findConnection(tenantId);
      return toConnectionView(connection);
    },

    async disconnectGoogle(input) {
      const tenantId = requireTenant(input?.tenantId, "disconnectGoogle");
      const log = deps.logger.child({ tenant_id: tenantId });
      const actorEmail = str(input?.actorEmail).toLowerCase() || null;

      // Read the token BEFORE deleting it: revoking is what stops Google from
      // handing out access tokens after the operator pressed "Ngắt kết nối".
      const refreshToken = await deps.oauth.findRefreshToken(tenantId);
      if (refreshToken) {
        try {
          await deps.client.revoke({ refreshToken });
        } catch (error) {
          // Warn + continue ON PURPOSE (and only here): a revoke Google refuses
          // must not leave a connection the operator cannot get rid of. The
          // local credential is deleted below either way.
          log.warn("Could not revoke the Google refresh token — disconnecting locally anyway", {
            step: "revoke",
            reason: "REVOKE_FAILED",
            err: AppError.from(error, "INTERNAL", { tenant_id: tenantId }).toLogObject(),
          });
        }
      }

      const actorUserId = await resolveActorUserId({ users: deps.users }, tenantId, { actorEmail }, log);
      const { removed } = await deps.oauth.deleteConnection({ tenantId, actorUserId, actorEmail });
      deps.authCache.invalidate(tenantId);

      log.info("Google Drive disconnected", {
        step: "disconnect",
        removed,
        revoked: Boolean(refreshToken),
        actor_email: actorEmail,
      });

      return { state: "not_connected" };
    },
  };
}

// --- helpers ----------------------------------------------------------------

export function toConnectionView(connection: GoogleOAuthConnection | null): GoogleConnectionView {
  if (!connection) return { state: "not_connected" };
  if (connection.status === "error") {
    return {
      state: "expired",
      email: connection.email,
      connectedAt: connection.connectedAt,
      reason: "GOOGLE_AUTH_EXPIRED",
    };
  }
  return {
    state: "connected",
    email: connection.email,
    connectedAt: connection.connectedAt,
    scopes: connection.scopes,
    // No stored result = never checked. It reads as "chưa rõ", NOT as "ổn":
    // claiming access nobody verified is how the empty-folder trap got shipped.
    sourceAccess: connection.sourceAccess?.state ?? "unknown",
  };
}

function normaliseScopes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const scopes = raw.map((item) => str(item)).filter((item) => item.length > 0);
  return Array.from(new Set(scopes));
}

function requireTenant(raw: unknown, operation: string): string {
  const tenantId = str(raw);
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: "Connecting Google Drive requires a tenant UUID",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: tenantId || null, operation },
    });
  }
  return tenantId;
}

/**
 * Length-independent comparison of two nonces. The caller controls one side, so
 * a byte-by-byte early exit would leak the issued state one character at a time.
 * Pure TypeScript: core cannot reach node:crypto (docs/07 §2).
 */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
