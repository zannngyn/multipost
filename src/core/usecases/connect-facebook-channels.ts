import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelConfigRepo,
  ChannelConnectClient,
  ChannelUpsert,
  RemoteChannelAccount,
} from "@/core/ports/publisher";
import type { UserRepo } from "@/core/ports/user-repo";

import { toChannelView, type ChannelView } from "./manage-channels";
import { resolveActorUserId } from "./resolve-actor";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E5.1 — "Kết nối Fanpage". Two doors, ONE core:
 *
 *   A. OAuth      : start -> Facebook -> callback(code) -> user token -> import
 *   B. paste token: the operator hands over a User Access Token -> import
 *
 * Both end in `importChannels`, so the Page listing, the channel id rule and
 * the upsert exist exactly once. Door B exists because a Meta app can hand out
 * a usable user token before its App Secret is available, and an operator must
 * not have to wait for that to publish.
 *
 * SECRETS: the user token and every Page token pass through this file. They are
 * never logged, never put in an AppError context, never returned — the view
 * shape (`ChannelView`) has no token field at all.
 *
 * The scopes a token must carry: pages_show_list, pages_manage_posts,
 * pages_read_engagement (the adapter asks for exactly these in the OAuth URL).
 */

/** Stable and collision-free: one Facebook Page is one channel, forever. */
export const FACEBOOK_CHANNEL_ID_PREFIX = "fb-";

export function facebookChannelId(pageId: string): string {
  return `${FACEBOOK_CHANNEL_ID_PREFIX}${pageId}`;
}

export interface StartFacebookConnectInput {
  readonly tenantId: TenantId;
}

export interface StartFacebookConnectResult {
  readonly tenantId: TenantId;
  /** CSRF nonce; the route stores it in an httpOnly cookie and re-checks it. */
  readonly state: string;
  readonly authorizeUrl: string;
}

export interface CompleteFacebookConnectInput {
  /** Read from the state cookie, NEVER from the query string. */
  readonly tenantId: TenantId;
  readonly code: string;
  /** `state` as Facebook echoed it back. */
  readonly state: string;
  /** `state` as we minted it, out of the httpOnly cookie. */
  readonly expectedState: string;
  readonly actorEmail?: string | null;
}

export interface ImportChannelsInput {
  readonly tenantId: TenantId;
  /** SECRET. Body-only; it must never reach a query string or a log. */
  readonly userAccessToken: string;
  readonly actorEmail?: string | null;
}

export interface RefreshChannelsInput {
  readonly tenantId: TenantId;
  readonly actorEmail?: string | null;
}

export interface ImportChannelsResult {
  readonly tenantId: TenantId;
  /** Channels that did not exist before this import. */
  readonly imported: number;
  /** Channels whose name/token were refreshed. */
  readonly updated: number;
  /** Pages the platform listed without a usable token (see logs for the ids). */
  readonly skipped: number;
  readonly channels: readonly ChannelView[];
}

export interface ConnectFacebookChannelsDeps {
  channels: ChannelConfigRepo;
  connect: ChannelConnectClient;
  logger: Logger;
  /** CSPRNG hex, injected: core must not know node:crypto exists. */
  newState: () => string;
  users?: UserRepo;
}

export interface ConnectFacebookChannels {
  startFacebookConnect(input: StartFacebookConnectInput): Promise<StartFacebookConnectResult>;
  completeFacebookConnect(input: CompleteFacebookConnectInput): Promise<ImportChannelsResult>;
  importChannels(input: ImportChannelsInput): Promise<ImportChannelsResult>;
  refreshChannels(input: RefreshChannelsInput): Promise<ImportChannelsResult>;
}

export function makeConnectFacebookChannels(
  deps: ConnectFacebookChannelsDeps,
): ConnectFacebookChannels {
  /**
   * The shared core of both doors: list the Pages a user token manages, write
   * them, read the result back for the screen.
   */
  async function importChannels(input: ImportChannelsInput): Promise<ImportChannelsResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = requireTenant(input?.tenantId, "importChannels");
    const userAccessToken = str(input?.userAccessToken);
    if (userAccessToken.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "importChannels requires a Facebook user access token",
        // Length only in the context below — never the value itself.
        userMessage: "Thiếu User Access Token của Facebook — hãy dán token rồi thử lại.",
        context: { tenant_id: tenantId, field: "userAccessToken", reason: "EMPTY" },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId });
    const actorEmail = str(input?.actorEmail).toLowerCase() || null;

    // A short-lived token would make every Page token die within hours; extend
    // it when the app secret is configured (the adapter decides and says so).
    const extended = await deps.connect.extendUserToken({ userAccessToken });
    if (!extended.extended) {
      log.warn("User token was not extended — Page tokens live only as long as it does", {
        reason: "APP_SECRET_MISSING",
        step: "extend_user_token",
      });
    }

    const listed = await deps.connect.listAccounts({
      userAccessToken: extended.userAccessToken,
    });

    if (listed.skipped.length > 0) {
      // Loud, with ids: "vì sao Page X không xuất hiện" must be answerable.
      log.warn("Some Pages were listed without a usable token and were not saved", {
        reason: "PAGE_TOKEN_MISSING",
        pages: listed.skipped,
        step: "list_accounts",
      });
    }

    if (listed.accounts.length === 0) {
      // Never "saved 0 Pages, all good": an empty list means the token has no
      // Page or is missing the scope, and both need the operator to act.
      throw new AppError("CHANNEL_NOT_CONFIGURED", {
        message: "The Facebook user token manages no usable Page",
        userMessage:
          "Token này không quản lý Trang nào, hoặc thiếu quyền pages_show_list / pages_manage_posts / pages_read_engagement. Hãy cấp đủ quyền rồi lấy token mới.",
        context: {
          tenant_id: tenantId,
          reason: "NO_PAGES",
          skipped: listed.skipped.length,
        },
      });
    }

    const actorUserId = await resolveActorUserId(
      { users: deps.users },
      tenantId,
      { actorEmail },
      log,
    );

    const result = await deps.channels.upsertChannels({
      tenantId,
      channels: listed.accounts.map(toChannelUpsert),
      // Stored (sealed) so "làm mới danh sách" needs no second paste.
      userAccessToken: extended.userAccessToken,
      actorEmail,
      actorUserId,
    });

    const channels = await deps.channels.listChannels(tenantId);

    log.info("Facebook channels imported", {
      added: result.added,
      updated: result.updated,
      skipped: listed.skipped.length,
      token_extended: extended.extended,
      token_expires_at: extended.expiresAt?.toISOString() ?? null,
      actor_email: actorEmail,
    });

    return {
      tenantId,
      imported: result.added.length,
      updated: result.updated.length,
      skipped: listed.skipped.length,
      channels: channels.map(toChannelView),
    };
  }

  return {
    async startFacebookConnect(input) {
      const tenantId = requireTenant(input?.tenantId, "startFacebookConnect");
      const state = str(deps.newState());
      if (state.length < 16) {
        // A weak/empty state would make the callback's CSRF check theatre.
        throw new AppError("INTERNAL", {
          message: "The generated OAuth state is too short to be a CSRF nonce",
          context: { tenant_id: tenantId, state_length: state.length },
        });
      }

      const authorizeUrl = deps.connect.buildAuthorizeUrl({ state });
      deps.logger.info("Facebook connect started", {
        tenant_id: tenantId,
        step: "authorize",
      });
      return { tenantId, state, authorizeUrl };
    },

    async completeFacebookConnect(input) {
      // --- Edge cases first: CSRF before anything touches the network -------
      const tenantId = requireTenant(input?.tenantId, "completeFacebookConnect");
      const expectedState = str(input?.expectedState);
      const state = str(input?.state);
      if (expectedState.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "The OAuth state cookie is missing or expired",
          userMessage:
            "Phiên kết nối Facebook đã hết hạn hoặc bị chặn cookie — hãy bấm “Kết nối Facebook” lại.",
          context: { tenant_id: tenantId, reason: "STATE_MISSING" },
        });
      }
      if (state.length === 0 || !constantTimeEquals(state, expectedState)) {
        throw new AppError("INVALID_INPUT", {
          message: "The OAuth state does not match the one we issued",
          userMessage:
            "Phiên kết nối Facebook không hợp lệ (state không khớp) — hãy bấm “Kết nối Facebook” lại.",
          context: { tenant_id: tenantId, reason: "STATE_MISMATCH" },
        });
      }

      const code = str(input?.code);
      if (code.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Facebook returned no authorization code",
          userMessage: "Facebook không trả về mã uỷ quyền — hãy thử kết nối lại.",
          context: { tenant_id: tenantId, reason: "CODE_MISSING" },
        });
      }

      const exchanged = await deps.connect.exchangeCodeForUserToken({ code });
      return importChannels({
        tenantId,
        userAccessToken: exchanged.userAccessToken,
        actorEmail: input?.actorEmail ?? null,
      });
    },

    importChannels,

    async refreshChannels(input) {
      const tenantId = requireTenant(input?.tenantId, "refreshChannels");
      const stored = await deps.channels.findUserAccessToken(tenantId);
      if (!stored) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "No stored Facebook user token for this tenant",
          userMessage:
            "Chưa có token Facebook nào được lưu cho đơn vị này — hãy dán User Access Token mới rồi nhập lại danh sách Trang.",
          context: { tenant_id: tenantId, reason: "USER_TOKEN_MISSING" },
        });
      }

      return importChannels({
        tenantId,
        userAccessToken: stored,
        actorEmail: input?.actorEmail ?? null,
      });
    },
  };
}

// --- helpers ----------------------------------------------------------------

function toChannelUpsert(account: RemoteChannelAccount): ChannelUpsert {
  return {
    channelId: facebookChannelId(account.externalId),
    platform: "facebook",
    name: account.name,
    externalId: account.externalId,
    accessToken: account.accessToken,
    tokenExpiresAt: account.tokenExpiresAt,
  };
}

function requireTenant(raw: TenantId | undefined, operation: string): TenantId {
  if (typeof raw !== "string" || !isTenantId(raw.trim())) {
    throw new AppError("INVALID_INPUT", {
      message: "Connecting channels requires a tenant UUID",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: (typeof raw === "string" ? raw.trim() : "") || null, operation },
    });
  }
  return normalizeTenantId(raw);
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
