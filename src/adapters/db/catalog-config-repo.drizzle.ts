import { eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";

import type { Database } from "./client";
import { tenantIntegrations } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * Reads the tenant's Drive/Sheet coordinates from `tenant_integration`
 * (CLAUDE.md business rule 7: no hardcoded folder or spreadsheet id).
 *
 * The JSONB blob is external-ish data — someone edits it by hand — so it goes
 * through a schema before it is trusted (technical rule 2).
 */

export const GOOGLE_PROVIDER = "google";

const CatalogConfigSchema = z.object({
  driveFolderId: z.string().trim().min(1),
  spreadsheetId: z.string().trim().min(1),
  sheetName: z.string().trim().min(1),
});

export class DrizzleCatalogConfigRepo implements CatalogConfigRepo {
  constructor(private readonly db: Database) {}

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
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
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
}
