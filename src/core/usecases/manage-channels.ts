import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelStatus,
} from "@/core/ports/publisher";

import { resolveActorUserId } from "./resolve-actor";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E5.1 — the channel list an operator manages: read it, switch one on/off,
 * remove one. Connecting new channels lives in connect-facebook-channels.
 *
 * The one rule this file exists to enforce: `accessToken` NEVER leaves the
 * server. `toChannelView` is the only shape the API layer ever sees, and it has
 * no token field — a new credential added to ChannelConfig therefore cannot leak
 * into a response by accident (allowlist on the way out).
 */

export interface ChannelView {
  readonly channelId: string;
  readonly platform: ChannelPlatform;
  readonly name: string;
  readonly externalId: string;
  readonly status: ChannelStatus;
  /** Serialised as an ISO string by the route; null when the platform gave none. */
  readonly tokenExpiresAt: Date | null;
}

/** Allowlist on the way out — everything not named here stays on the server. */
export function toChannelView(channel: ChannelConfig): ChannelView {
  return {
    channelId: channel.channelId,
    platform: channel.platform,
    name: channel.name,
    externalId: channel.externalId,
    status: channel.status,
    tokenExpiresAt: channel.tokenExpiresAt,
  };
}

export interface ListChannelsInput {
  readonly tenantId: TenantId;
}

export interface SetChannelStatusRequest {
  readonly tenantId: TenantId;
  readonly channelId: string;
  readonly status: ChannelStatus;
  readonly actorEmail?: string | null;
}

export interface RemoveChannelRequest {
  readonly tenantId: TenantId;
  readonly channelId: string;
  readonly actorEmail?: string | null;
}

export interface ManageChannelsDeps {
  channels: ChannelConfigRepo;
  logger: Logger;
  /** Optional: without it the audit row carries the e-mail but no actor id. */
  users?: UserRepo;
}

export interface ManageChannels {
  listChannels(input: ListChannelsInput): Promise<readonly ChannelView[]>;
  setChannelStatus(input: SetChannelStatusRequest): Promise<ChannelView>;
  removeChannel(input: RemoveChannelRequest): Promise<{ channelId: string; removed: true }>;
}

const STATUSES: readonly ChannelStatus[] = ["active", "disabled"];

export function makeManageChannels(deps: ManageChannelsDeps): ManageChannels {
  return {
    /**
     * A tenant with no integration row answers an EMPTY LIST, not an error: it
     * is a tenant nobody has connected yet, and the screen shows its empty state.
     */
    async listChannels(input) {
      const tenantId = requireTenant(input?.tenantId, "listChannels");
      const channels = await deps.channels.listChannels(tenantId);
      deps.logger.debug("Channels listed", {
        tenant_id: tenantId,
        channel_count: channels.length,
      });
      return channels.map(toChannelView);
    },

    async setChannelStatus(input) {
      // --- Edge cases first ---------------------------------------------------
      const tenantId = requireTenant(input?.tenantId, "setChannelStatus");
      const channelId = requireChannelId(input?.channelId, tenantId, "setChannelStatus");
      const status = input?.status;
      if (!STATUSES.includes(status)) {
        throw new AppError("INVALID_INPUT", {
          message: `Channel status must be one of ${STATUSES.join(", ")}`,
          userMessage: "Trạng thái kênh không hợp lệ (chỉ nhận bật hoặc tắt).",
          context: { tenant_id: tenantId, channel: channelId, field: "status" },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId, channel: channelId });
      const actorEmail = str(input?.actorEmail).toLowerCase() || null;
      const actorUserId = await resolveActorUserId(
        { users: deps.users },
        tenantId,
        { actorEmail },
        log,
      );

      const updated = await deps.channels.setChannelStatus({
        tenantId,
        channelId,
        status,
        actorEmail,
        actorUserId,
      });
      if (!updated) throw channelNotFound(tenantId, channelId, "setChannelStatus");

      // info: "vì sao kênh này không nhận bài hôm nay" is answered by this line.
      log.info("Channel status changed", { status, actor_email: actorEmail });
      return toChannelView(updated);
    },

    async removeChannel(input) {
      const tenantId = requireTenant(input?.tenantId, "removeChannel");
      const channelId = requireChannelId(input?.channelId, tenantId, "removeChannel");

      const log = deps.logger.child({ tenant_id: tenantId, channel: channelId });
      const actorEmail = str(input?.actorEmail).toLowerCase() || null;
      const actorUserId = await resolveActorUserId(
        { users: deps.users },
        tenantId,
        { actorEmail },
        log,
      );

      const removed = await deps.channels.removeChannel({
        tenantId,
        channelId,
        actorEmail,
        actorUserId,
      });
      if (!removed) throw channelNotFound(tenantId, channelId, "removeChannel");

      log.info("Channel removed", { actor_email: actorEmail });
      return { channelId, removed: true };
    },
  };
}

// --- helpers ----------------------------------------------------------------

function requireTenant(raw: TenantId | undefined, operation: string): TenantId {
  if (typeof raw !== "string" || !isTenantId(raw.trim())) {
    throw new AppError("INVALID_INPUT", {
      message: "Channel operations require a tenant UUID",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: (typeof raw === "string" ? raw.trim() : "") || null, operation },
    });
  }
  return normalizeTenantId(raw);
}

function requireChannelId(raw: unknown, tenantId: TenantId, operation: string): string {
  const channelId = str(raw);
  if (channelId.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Channel operations require a channel id",
      userMessage: "Thiếu mã kênh.",
      context: { tenant_id: tenantId, field: "channelId", operation },
    });
  }
  return channelId;
}

function channelNotFound(tenantId: TenantId, channelId: string, operation: string): AppError {
  return new AppError("CHANNEL_NOT_CONFIGURED", {
    message: "Channel not found for this tenant",
    userMessage: `Không tìm thấy kênh "${channelId}" trong đơn vị này.`,
    context: { tenant_id: tenantId, channel: channelId, operation, reason: "CHANNEL_NOT_FOUND" },
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
