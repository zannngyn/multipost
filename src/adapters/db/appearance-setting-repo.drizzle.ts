import { eq } from "drizzle-orm";

import type {
  AppearanceSettingRepo,
  WriteAppearancePresetRecord,
} from "@/core/ports/appearance-setting-repo";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { APPEARANCE_PRESET_SETTING_KEY, auditLogs, platformSettings } from "./schema";

/**
 * The platform appearance setting (M3.4). NOT behind `forTenant()` — like
 * `platform-tenant-repo`, this is the layer that operates MYSP itself, and the
 * row it owns belongs to no company.
 *
 * The value is stored as a bare JSON string (`"cham"`), not `{"presetId":…}`:
 * the column is `jsonb` so a future setting can be an object, but wrapping a
 * single scalar in an object buys nothing and gives the reader a second shape
 * to get wrong.
 */
export class DrizzleAppearanceSettingRepo implements AppearanceSettingRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async read(): Promise<unknown> {
    try {
      const rows = await this.db
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(eq(platformSettings.key, APPEARANCE_PRESET_SETTING_KEY))
        .limit(1);

      // No row = never set. Returned as null, NOT as the default: only the
      // usecase knows which ids are still real (see the port contract).
      return rows[0]?.value ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "appearanceSetting.read",
        setting_key: APPEARANCE_PRESET_SETTING_KEY,
      });
    }
  }

  async write(record: WriteAppearancePresetRecord): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // Upsert: ONE row per key, always. A second call replaces.
        await tx
          .insert(platformSettings)
          .values({
            key: APPEARANCE_PRESET_SETTING_KEY,
            value: record.presetId,
            updatedByAccountId: record.actorAccountId,
          })
          .onConflictDoUpdate({
            target: platformSettings.key,
            set: {
              value: record.presetId,
              updatedByAccountId: record.actorAccountId,
              updatedAt: new Date(),
            },
          });

        // `tenant_id` stays NULL: the audit-log column is nullable exactly for
        // `platform.%` actions, and borrowing some company's id would file a
        // platform-wide change under a customer that had nothing to do with it.
        await tx.insert(auditLogs).values({
          tenantId: null,
          actorUserId: null,
          actorKind: "user",
          action: "platform.appearance_changed",
          entityType: "platform_setting",
          entityId: APPEARANCE_PRESET_SETTING_KEY,
          payload: {
            preset_id: record.presetId,
            previous_preset_id: record.previousPresetId,
            actor_account_id: record.actorAccountId,
            actor_email: record.actorEmail,
          },
        });
      });

      this.deps.logger.info("Platform appearance preset written", {
        preset_id: record.presetId,
        previous_preset_id: record.previousPresetId,
        actor_account_id: record.actorAccountId,
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "appearanceSetting.write",
        setting_key: APPEARANCE_PRESET_SETTING_KEY,
        preset_id: record.presetId,
      });
    }
  }
}
