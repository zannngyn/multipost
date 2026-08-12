import { eq } from "drizzle-orm";

import type { ChannelGroup } from "@/core/domain/channel-group";
import { AppError } from "@/core/domain/errors";
import type { ChannelGroupRepo } from "@/core/ports/publisher";

import type { Database } from "./client";
import { isPgError, wrapDbError } from "./db-errors";
import { channelGroups, type ChannelGroupRow } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * channel_group persistence (E7.6). Tenant-scoped like every repo here.
 *
 * The unique (tenant_id, name) index is the authority on duplicate names: a
 * "read then insert" check would let two concurrent creates through. The
 * violation is translated into INVALID_INPUT + reason CHANNEL_GROUP_NAME_TAKEN
 * so the operator sees a sentence, not a Postgres error.
 */

/** Postgres unique_violation — the (tenant_id, name) index firing. */
const PG_UNIQUE_VIOLATION = "23505";

function nameTaken(tenantId: string, name: string, error: unknown): AppError {
  return new AppError("INVALID_INPUT", {
    message: `A channel group named "${name}" already exists for this tenant`,
    userMessage: `Đã có nhóm kênh tên "${name}" — hãy đặt tên khác.`,
    context: { tenant_id: tenantId, name, reason: "CHANNEL_GROUP_NAME_TAKEN" },
    cause: error,
  });
}

function toDomain(row: ChannelGroupRow): ChannelGroup {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    // JSONB is external-ish data (hand edits, older writes): keep only strings.
    channelIds: Array.isArray(row.channelIds)
      ? row.channelIds.filter((value): value is string => typeof value === "string")
      : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleChannelGroupRepo implements ChannelGroupRepo {
  constructor(private readonly db: Database) {}

  async listGroups(tenantId: string): Promise<readonly ChannelGroup[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select()
        .from(channelGroups)
        .where(scope.where(channelGroups))
        .orderBy(channelGroups.name);
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelGroup.list",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async findGroupById(tenantId: string, groupId: string): Promise<ChannelGroup | null> {
    const scope = forTenant(this.db, tenantId);
    const id = str(groupId);
    if (id.length === 0) throw missingId(scope.tenantId, "channelGroup.findGroupById");

    try {
      const rows = await scope.db
        .select()
        .from(channelGroups)
        .where(scope.where(channelGroups, eq(channelGroups.id, id)))
        .limit(1);
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelGroup.findGroupById",
        tenant_id: scope.tenantId,
        group_id: id,
        field: "groupId",
      });
    }
  }

  async createGroup(input: {
    id: string;
    tenantId: string;
    name: string;
    channelIds: readonly string[];
  }): Promise<ChannelGroup> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const id = str(input?.id);
    if (id.length === 0) throw missingId(scope.tenantId, "channelGroup.createGroup");

    try {
      const rows = await scope.db
        .insert(channelGroups)
        .values(
          scope.row({
            id,
            name: input.name,
            channelIds: [...input.channelIds],
          }),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new AppError("DB_ERROR", {
          message: "Insert returned no channel_group row",
          context: { tenant_id: scope.tenantId, group_id: id },
        });
      }
      return toDomain(row);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) throw nameTaken(scope.tenantId, input.name, error);
      throw wrapDbError(error, {
        operation: "channelGroup.createGroup",
        tenant_id: scope.tenantId,
        group_id: id,
        field: "groupId",
      });
    }
  }

  async updateGroup(input: {
    tenantId: string;
    groupId: string;
    name: string;
    channelIds: readonly string[];
  }): Promise<ChannelGroup | null> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const id = str(input?.groupId);
    if (id.length === 0) throw missingId(scope.tenantId, "channelGroup.updateGroup");

    try {
      const rows = await scope.db
        .update(channelGroups)
        .set({ name: input.name, channelIds: [...input.channelIds], updatedAt: new Date() })
        .where(scope.where(channelGroups, eq(channelGroups.id, id)))
        .returning();
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) throw nameTaken(scope.tenantId, input.name, error);
      throw wrapDbError(error, {
        operation: "channelGroup.updateGroup",
        tenant_id: scope.tenantId,
        group_id: id,
        field: "groupId",
      });
    }
  }

  async deleteGroup(tenantId: string, groupId: string): Promise<boolean> {
    const scope = forTenant(this.db, tenantId);
    const id = str(groupId);
    if (id.length === 0) throw missingId(scope.tenantId, "channelGroup.deleteGroup");

    try {
      const rows = await scope.db
        .delete(channelGroups)
        .where(scope.where(channelGroups, eq(channelGroups.id, id)))
        .returning({ id: channelGroups.id });
      return rows.length > 0;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelGroup.deleteGroup",
        tenant_id: scope.tenantId,
        group_id: id,
        field: "groupId",
      });
    }
  }
}

function missingId(tenantId: string, operation: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: `${operation} requires a channel group id`,
    userMessage: "Thiếu mã nhóm kênh.",
    context: { tenant_id: tenantId, operation },
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
