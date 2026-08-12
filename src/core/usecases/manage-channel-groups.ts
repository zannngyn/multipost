import {
  normaliseChannelGroupFields,
  unknownChannelIds,
  type ChannelGroup,
} from "@/core/domain/channel-group";
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { ChannelConfigRepo, ChannelGroupRepo } from "@/core/ports/publisher";

/**
 * E7.6 — saved channel presets ("nhóm kênh đặt sẵn"): list / create / update /
 * delete. A group is only a shortcut for the channel picker; it grants nothing
 * and skips nothing (fan-out and the publish gates are untouched).
 *
 * Every write validates membership against the tenant's REAL channels
 * (tenant_integration). A group naming a channel the tenant no longer has would
 * quietly shrink a fan-out later — the operator would tick "5 kênh" and get 4.
 */

export interface ChannelGroupView {
  readonly id: string;
  readonly name: string;
  readonly channelIds: readonly string[];
  readonly channelCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListChannelGroupsInput {
  readonly tenantId: string;
}

export interface CreateChannelGroupInput {
  readonly tenantId: string;
  readonly name: string;
  readonly channelIds: readonly string[];
}

export interface UpdateChannelGroupInput {
  readonly tenantId: string;
  readonly groupId: string;
  readonly name: string;
  readonly channelIds: readonly string[];
}

export interface DeleteChannelGroupInput {
  readonly tenantId: string;
  readonly groupId: string;
}

export interface DeleteChannelGroupResult {
  readonly groupId: string;
  readonly deleted: true;
}

export interface ManageChannelGroupsDeps {
  groups: ChannelGroupRepo;
  /** The source of truth for which channels exist (tenant_integration). */
  channels: ChannelConfigRepo;
  logger: Logger;
  newId: () => string;
}

export interface ManageChannelGroups {
  listChannelGroups(input: ListChannelGroupsInput): Promise<readonly ChannelGroupView[]>;
  createChannelGroup(input: CreateChannelGroupInput): Promise<ChannelGroupView>;
  updateChannelGroup(input: UpdateChannelGroupInput): Promise<ChannelGroupView>;
  deleteChannelGroup(input: DeleteChannelGroupInput): Promise<DeleteChannelGroupResult>;
}

export function makeManageChannelGroups(deps: ManageChannelGroupsDeps): ManageChannelGroups {
  /** Rejects any channel id the tenant does not own — the whole point of E7.6. */
  async function assertChannelsExist(
    tenantId: string,
    channelIds: readonly string[],
    context: Record<string, unknown>,
  ): Promise<void> {
    const known = await deps.channels.listChannels(tenantId);
    const unknown = unknownChannelIds(
      channelIds,
      known.map((channel) => channel.channelId),
    );
    if (unknown.length === 0) return;

    throw new AppError("INVALID_INPUT", {
      message: `Channel group references channels the tenant does not have: ${unknown.join(", ")}`,
      userMessage: `Nhóm kênh chứa kênh không tồn tại trong đơn vị: ${unknown.join(", ")}.`,
      context: {
        ...context,
        tenant_id: tenantId,
        reason: "UNKNOWN_CHANNEL_ID",
        unknown_channels: unknown,
        known_channels: known.map((channel) => channel.channelId),
      },
    });
  }

  return {
    async listChannelGroups(input) {
      const tenantId = requireTenant(input?.tenantId);
      const groups = await deps.groups.listGroups(tenantId);
      deps.logger.debug("Channel groups listed", {
        tenant_id: tenantId,
        group_count: groups.length,
      });
      return groups.map(toView);
    },

    async createChannelGroup(input) {
      // --- Edge cases first -------------------------------------------------
      const tenantId = requireTenant(input?.tenantId);
      const fields = normaliseChannelGroupFields(input);
      await assertChannelsExist(tenantId, fields.channelIds, { operation: "createChannelGroup" });

      const group = await deps.groups.createGroup({
        id: deps.newId(),
        tenantId,
        name: fields.name,
        channelIds: fields.channelIds,
      });
      deps.logger.info("Channel group created", {
        tenant_id: tenantId,
        group_id: group.id,
        name: group.name,
        channels: group.channelIds,
      });
      return toView(group);
    },

    async updateChannelGroup(input) {
      const tenantId = requireTenant(input?.tenantId);
      const groupId = requireGroupId(input?.groupId, tenantId);
      const fields = normaliseChannelGroupFields(input);
      await assertChannelsExist(tenantId, fields.channelIds, {
        operation: "updateChannelGroup",
        group_id: groupId,
      });

      const updated = await deps.groups.updateGroup({
        tenantId,
        groupId,
        name: fields.name,
        channelIds: fields.channelIds,
      });
      if (!updated) throw notFound(tenantId, groupId, "updateChannelGroup");

      deps.logger.info("Channel group updated", {
        tenant_id: tenantId,
        group_id: updated.id,
        name: updated.name,
        channels: updated.channelIds,
      });
      return toView(updated);
    },

    async deleteChannelGroup(input) {
      const tenantId = requireTenant(input?.tenantId);
      const groupId = requireGroupId(input?.groupId, tenantId);

      const deleted = await deps.groups.deleteGroup(tenantId, groupId);
      if (!deleted) throw notFound(tenantId, groupId, "deleteChannelGroup");

      deps.logger.info("Channel group deleted", { tenant_id: tenantId, group_id: groupId });
      return { groupId, deleted: true };
    },
  };
}

// --- helpers ----------------------------------------------------------------

function toView(group: ChannelGroup): ChannelGroupView {
  return {
    id: group.id,
    name: group.name,
    channelIds: group.channelIds,
    channelCount: group.channelIds.length,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function requireTenant(raw: unknown): string {
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: "Channel group operations require a tenant UUID",
      userMessage: "Yêu cầu quản lý nhóm kênh thiếu mã đơn vị.",
      context: { tenant_id: tenantId || null },
    });
  }
  return tenantId;
}

function requireGroupId(raw: unknown, tenantId: string): string {
  const groupId = typeof raw === "string" ? raw.trim() : "";
  if (groupId.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Channel group operations require a group id",
      userMessage: "Thiếu mã nhóm kênh.",
      context: { tenant_id: tenantId, field: "groupId" },
    });
  }
  return groupId;
}

function notFound(tenantId: string, groupId: string, operation: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: "Channel group not found for this tenant",
    userMessage: "Không tìm thấy nhóm kênh này.",
    context: { tenant_id: tenantId, group_id: groupId, operation, reason: "GROUP_NOT_FOUND" },
  });
}
