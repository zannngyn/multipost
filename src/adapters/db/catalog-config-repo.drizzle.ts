import { eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  SaveCatalogSourceInput,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { auditLogs, tenantIntegrations } from "./schema";
import { findPlaintextSecretFields } from "./secret-box";
import { forTenant } from "./tenant-scope";

/**
 * Reads the tenant's Drive/Sheet coordinates from `tenant_integration`
 * (CLAUDE.md business rule 7: no hardcoded folder or spreadsheet id).
 *
 * The JSONB blob is external-ish data — someone edits it by hand — so it goes
 * through a schema before it is trusted (technical rule 2).
 *
 * Encryption: the google row holds NO credential (a folder id, a spreadsheet id
 * and a tab name are not secrets — access comes from the Service Account key in
 * env), so nothing here is sealed. What the repo does do is warn when a
 * secret-looking field shows up unencrypted, which is how a token pasted into
 * the wrong provider row becomes visible instead of silently stored in clear.
 */

export const GOOGLE_PROVIDER = "google";

const CatalogConfigSchema = z.object({
  driveFolderId: z.string().trim().min(1),
  spreadsheetId: z.string().trim().min(1),
  sheetName: z.string().trim().min(1),
});

export class DrizzleCatalogConfigRepo implements CatalogConfigRepo {
  /** Logger is optional so existing call sites keep compiling; pass it in prod. */
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async findCatalogConfig(tenantId: string): Promise<CatalogSourceConfig | null> {
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ config: Record<string, unknown>; status: string }>;
    try {
      rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(
          scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)),
        )
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "catalogConfig.find",
      });
    }

    const row = rows[0];
    if (!row) return null;

    if (row.status === "disabled") {
      throw new AppError("SYNC_FAILED", {
        message: "Google integration is disabled for this tenant",
        userMessage: "Tích hợp Google của đơn vị này đang bị tắt.",
        context: { tenant_id: scope.tenantId, provider: GOOGLE_PROVIDER },
      });
    }

    const plaintextSecrets = findPlaintextSecretFields(row.config);
    if (plaintextSecrets.length > 0) {
      // Field NAMES only — a warning that leaks the token defeats its purpose.
      this.logger?.warn("tenant_integration.config holds unencrypted secret-looking fields", {
        scope: "secrets",
        reason: "PLAINTEXT_LEGACY",
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        fields: plaintextSecrets,
      });
    }

    const parsed = CatalogConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      // A half-filled integration row must not turn into an empty sync that
      // looks successful — fail loudly and name the missing keys.
      throw new AppError("SYNC_FAILED", {
        message: "tenant_integration.config is missing Drive/Sheet keys",
        userMessage:
          "Cấu hình Drive/Sheet của đơn vị chưa đầy đủ (thiếu driveFolderId / spreadsheetId / sheetName).",
        context: {
          tenant_id: scope.tenantId,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
      });
    }

    return {
      driveFolderId: parsed.data.driveFolderId,
      spreadsheetId: parsed.data.spreadsheetId,
      sheetName: parsed.data.sheetName,
    };
  }

  /**
   * Read-model twin: same row, but a missing/half-filled/disabled integration
   * is "chưa cấu hình" instead of a thrown error. The reason is logged, because
   * a row that exists but cannot be parsed is a different problem from no row
   * at all — the panel just does not need to say which.
   */
  async findCatalogSource(tenantId: string): Promise<CatalogSourceConfig | null> {
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ config: Record<string, unknown>; status: string }>;
    try {
      rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
        .limit(1);
    } catch (error) {
      // A driver failure is NOT "not configured" — the panel must not invite
      // the operator to re-enter a source that is already there.
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "catalogConfig.findSource",
      });
    }

    const row = rows[0];
    if (!row) return null;

    if (row.status === "disabled") {
      this.logger?.warn("Google integration is disabled — panel shows it as unconfigured", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "INTEGRATION_DISABLED",
      });
      return null;
    }

    const parsed = CatalogConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      this.logger?.warn("tenant_integration.config is missing Drive/Sheet keys", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "CONFIG_INCOMPLETE",
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
      return null;
    }

    return {
      driveFolderId: parsed.data.driveFolderId,
      spreadsheetId: parsed.data.spreadsheetId,
      sheetName: parsed.data.sheetName,
    };
  }

  /**
   * Upsert + audit in ONE transaction. The previous config is read inside that
   * transaction so two operators saving at the same time cannot produce an
   * audit row claiming a change that never happened.
   *
   * Other keys of `config` are preserved: the google row is shared with future
   * provider settings, and a source change must not silently drop them.
   * `status` is left as it is on update — re-enabling a disabled integration is
   * a separate, deliberate action.
   */
  async saveCatalogSource(
    input: SaveCatalogSourceInput,
  ): Promise<{ previous: CatalogSourceConfig | null }> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const source = input?.source;
    if (
      !source ||
      typeof source.driveFolderId !== "string" ||
      typeof source.spreadsheetId !== "string" ||
      typeof source.sheetName !== "string" ||
      source.driveFolderId.trim().length === 0 ||
      source.spreadsheetId.trim().length === 0 ||
      source.sheetName.trim().length === 0
    ) {
      throw new AppError("INVALID_INPUT", {
        message: "saveCatalogSource requires driveFolderId, spreadsheetId and sheetName",
        userMessage: "Thiếu thông tin nguồn dữ liệu Drive/Sheet.",
        context: { tenant_id: scope.tenantId, field: "source" },
      });
    }

    const next: CatalogSourceConfig = {
      driveFolderId: source.driveFolderId.trim(),
      spreadsheetId: source.spreadsheetId.trim(),
      sheetName: source.sheetName.trim(),
    };

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const existing = await txScope.db
          .select({ config: tenantIntegrations.config })
          .from(tenantIntegrations)
          .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
          .limit(1);

        const currentConfig = existing[0]?.config ?? {};
        const parsedPrevious = CatalogConfigSchema.safeParse(currentConfig);
        const previous: CatalogSourceConfig | null = parsedPrevious.success
          ? {
              driveFolderId: parsedPrevious.data.driveFolderId,
              spreadsheetId: parsedPrevious.data.spreadsheetId,
              sheetName: parsedPrevious.data.sheetName,
            }
          : null;

        const mergedConfig = { ...currentConfig, ...next };

        await txScope.db
          .insert(tenantIntegrations)
          .values(txScope.row({ provider: GOOGLE_PROVIDER, config: mergedConfig }))
          .onConflictDoUpdate({
            target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
            set: { config: mergedConfig, updatedAt: new Date() },
          });

        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input.actorUserId ?? null,
            action: "catalog_source.updated",
            entityType: "tenant_integration",
            entityId: GOOGLE_PROVIDER,
            payload: {
              old: previous,
              new: next,
              actor_email: input.actorEmail ?? null,
            },
          }),
        );

        return { previous };
      });
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "source",
        operation: "catalogConfig.saveSource",
        provider: GOOGLE_PROVIDER,
      });
    }
  }
}
