import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { ReadSheetInput, SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import type { GoogleAuthClient } from "./service-account";
import { buildSheetSnapshot } from "./sheet-values";

/**
 * Sheets implementation of SheetSource (E2).
 * The API answers with a ragged array of arrays; it is validated here and
 * converted to name-addressed rows before core ever sees it (technical rule 2).
 */

/** Wide enough for the real tab (21 named + trailing unnamed columns). */
const RANGE_COLUMNS = "A:BZ";

const ValuesResponseSchema = z.object({
  range: z.string().nullish(),
  values: z.array(z.array(z.unknown())).nullish(),
});

export interface GoogleSheetSourceDeps {
  auth: GoogleAuthClient;
  logger: Logger;
}

export function makeGoogleSheetSource(deps: GoogleSheetSourceDeps): SheetSource {
  const sheets = google.sheets({ version: "v4", auth: deps.auth });

  return {
    async readRows(input: ReadSheetInput): Promise<SheetSnapshot> {
      // --- Edge cases first --------------------------------------------------
      const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
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
