import { jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Saved channel preset (E7.6) — "nhóm kênh đặt sẵn" of the brief.
 *
 * `channel_ids` is JSONB, not a join table, on purpose: a channel is not a row
 * here, it is an entry inside `tenant_integration.config` (provider = 'meta'), so
 * there is nothing to reference. Membership is therefore validated in the usecase
 * against the tenant's live channel list on every write — a stale id would
 * silently shrink a later fan-out.
 *
 * The unique (tenant_id, name) keeps the picker unambiguous: two groups called
 * "Toàn bộ Page" is an operator trap, and the DB is the only place that can
 * settle the race between two people creating it at once.
 */
export const channelGroups = pgTable(
  "channel_group",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    name: text("name").notNull(),
    /** Ordered channel ids as the operator arranged them. Never null. */
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  // Doubles as the tenant_id index (B-tree leftmost prefix).
  (table) => [unique("channel_group_tenant_name_uq").on(table.tenantId, table.name)],
);

export type ChannelGroupRow = typeof channelGroups.$inferSelect;
export type NewChannelGroupRow = typeof channelGroups.$inferInsert;
