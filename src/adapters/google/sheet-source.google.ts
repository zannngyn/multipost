import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { ReadSheetInput, SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { buildSheetSnapshot } from "./sheet-values";
import type { TenantGoogleAuth } from "./tenant-google-auth";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * Sheets implementation of SheetSource (E2).
 * The API answers with a ragged array of arrays; it is validated here and
 * converted to name-addressed rows before core ever sees it (technical rule 2).
 *
 * Identity is per tenant (see tenant-google-auth): the tenant's own OAuth
 * connection when they connected one, the Service Account otherwise.
 */

/** Wide enough for the real tab (21 named + trailing unnamed columns). */
const RANGE_COLUMNS = "A:BZ";

const ValuesResponseSchema = z.object({
  range: z.string().nullish(),
  values: z.array(z.array(z.unknown())).nullish(),
});

export interface GoogleSheetSourceDeps {
  auth: TenantGoogleAuth;
  logger: Logger;
}

export function makeGoogleSheetSource(deps: GoogleSheetSourceDeps): SheetSource {
  const sheetsFor = async (tenantId: TenantId) =>
    google.sheets({ version: "v4", auth: await deps.auth.forTenant(tenantId) });

  return {
    async readRows(input: ReadSheetInput): Promise<SheetSnapshot> {
      // --- Edge cases first --------------------------------------------------
      const tenantId = normalizeTenantId(input.tenantId);
      const spreadsheetId =
        typeof input?.spreadsheetId === "string" ? input.spreadsheetId.trim() : "";
      const sheetName = typeof input?.sheetName === "string" ? input.sheetName.trim() : "";
      if (spreadsheetId.length === 0 || sheetName.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "readRows requires a spreadsheet id and a sheet (tab) name",
          userMessage: "Chưa khai báo Google Sheet / tên tab cho đơn vị này.",
          context: { tenant_id: tenantId || null, spreadsheet_id: spreadsheetId || null },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId });
      const range = `'${sheetName.replace(/'/g, "''")}'!${RANGE_COLUMNS}`;

      const sheets = await sheetsFor(tenantId);
      let payload: unknown;
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          // Formatted values keep "1.450.000" as text; we never do maths on it.
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        });
        payload = response.data;
      } catch (error) {
        // Same rule as Drive: a dead tenant connection is GOOGLE_AUTH_EXPIRED,
        // never an empty snapshot that would blank the catalog.
        const authError = await deps.auth.reportAuthFailure(tenantId, error);
        if (authError) throw authError;
        throw AppError.from(error, "SHEET_ERROR", {
          tenant_id: tenantId || null,
          spreadsheet_id: spreadsheetId,
          sheet_name: sheetName,
          operation: "sheets.values.get",
        });
      }

      const parsed = ValuesResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("SHEET_ERROR", {
          message: "Sheets values.get returned an unexpected payload shape",
          context: {
            tenant_id: tenantId || null,
            spreadsheet_id: spreadsheetId,
            sheet_name: sheetName,
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }

      const grid = (parsed.data.values ?? []).map((row) =>
        row.map((cell) => (typeof cell === "string" ? cell : cell == null ? "" : String(cell))),
      );

      if (grid.length === 0) {
        // Empty tab is data, not a crash — the sync records it and moves on.
        log.warn("Sheet tab is empty", { spreadsheet_id: spreadsheetId, sheet_name: sheetName });
        return { columns: [], duplicateColumns: [], rows: [] };
      }

      const snapshot = buildSheetSnapshot(grid);
      log.info("Sheet read complete", {
        spreadsheet_id: spreadsheetId,
        sheet_name: sheetName,
        columns: snapshot.columns.length,
        rows: snapshot.rows.length,
        duplicate_columns: snapshot.duplicateColumns,
      });
      return snapshot;
    },
  };
}
