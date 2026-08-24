import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { accounts } from "./account";

/**
 * Settings that belong to the PLATFORM, not to any customer company (M3.4).
 *
 * NO `tenant_id`, deliberately — and it is the only business table without one.
 * These rows configure MYSP itself: one value, in force for every company at
 * once. Giving it a tenant column would invite a per-tenant read that the
 * feature does not have and the UI does not offer.
 *
 * Key/value rather than a column per setting: the platform layer collects small
 * scalars (a preset id today), and each one would otherwise be a migration on a
 * one-row table. The VALUE is jsonb so a later setting can be a small object
 * without another migration; nothing reads it untyped — every reader parses it
 * through its own guard and refuses what it does not recognise.
 *
 * Never trust the stored value: it was valid when written, and a deploy that
 * retires a preset makes yesterday's row unknown. Readers validate.
 */
export const platformSettings = pgTable("platform_setting", {
  /** Dotted namespace, e.g. `appearance.preset`. The whole primary key. */
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  /**
   * Who last wrote it. `set null` rather than cascade: the setting outlives the
   * staffer who set it, and losing the whole row would lose the setting itself.
   * The audit trail keeps the full story either way.
   */
  updatedByAccountId: uuid("updated_by_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  ...timestamps,
});

export type PlatformSettingRow = typeof platformSettings.$inferSelect;
export type NewPlatformSettingRow = typeof platformSettings.$inferInsert;

/** The one key this feature owns. A literal we control, never client input. */
export const APPEARANCE_PRESET_SETTING_KEY = "appearance.preset";
