import { AppError } from "@/core/domain/errors";
import { normalizeTenantId } from "@/core/domain/tenant-context";
import type {
  CatalogReadNotice,
  CatalogSourceRef,
  CatalogTextResult,
  CatalogTextSource,
  ReadCatalogTextInput,
} from "@/core/ports/catalog-text-source";
import type { Logger } from "@/core/ports/infra";
import type { SheetSource } from "@/core/ports/sheet-source";

/**
 * The existing Google tab, seen through CatalogTextSource.
 *
 * It takes the PORT (`SheetSource`), not the Google adapter, so it stays free
 * of googleapis and works over the sample-data fixture too. That is the whole
 * point of the abstraction: from here on, "sheet" and "uploaded CSV" are two
 * values of the same variable, and the field map / stock policy / row parser
 * cannot tell which one they are reading.
 */

export const SHEET_TEXT_SOURCE_ID = "google-sheet";

export interface SheetCatalogTextSourceDeps {
  sheet: SheetSource;
  logger: Logger;
}

export function makeSheetCatalogTextSource(deps: SheetCatalogTextSourceDeps): CatalogTextSource {
  return {
    id: SHEET_TEXT_SOURCE_ID,

    canRead(ref: CatalogSourceRef): boolean {
      return ref?.kind === "google_sheet";
    },

    async readCatalog(input: ReadCatalogTextInput): Promise<CatalogTextResult> {
      // --- Edge cases first (CLAUDE.md technical rule 1) -------------------
      const tenantId = normalizeTenantId(input?.tenantId);
      const ref = input?.ref;
      if (!ref || ref.kind !== "google_sheet") {
        throw new AppError("INVALID_INPUT", {
          message: "sheet catalog source received a ref it cannot read",
          userMessage: "Nguồn dữ liệu không phải Google Sheet.",
          context: { tenant_id: tenantId, reason: "REF_KIND_MISMATCH", ref_kind: ref?.kind ?? null },
        });
      }

      const spreadsheetId = typeof ref.spreadsheetId === "string" ? ref.spreadsheetId.trim() : "";
      const sheetName = typeof ref.sheetName === "string" ? ref.sheetName.trim() : "";
      if (spreadsheetId.length === 0 || sheetName.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "sheet catalog source requires a spreadsheet id and a tab name",
          userMessage: "Chưa khai báo bảng tính hoặc tên tab cho đơn vị này.",
          context: {
            tenant_id: tenantId,
            reason: "SHEET_REF_INCOMPLETE",
            spreadsheet_id: spreadsheetId || null,
            sheet_name: sheetName || null,
          },
        });
      }

      // The SheetSource contract already turns a transport failure into
      // AppError('SHEET_ERROR'); rethrowing it unchanged keeps ONE error shape
      // for the caller and does not hide where it came from.
      const snapshot = await deps.sheet.readRows({ tenantId, spreadsheetId, sheetName });

      const notices: CatalogReadNotice[] = snapshot.duplicateColumns.map((column) => ({
        code: "DUPLICATE_COLUMN",
        count: 1,
        examples: [column],
        detail: `Cột '${column}' xuất hiện nhiều lần trên bảng tính — hệ thống chỉ đọc cột đầu tiên.`,
      }));
      if (snapshot.columns.length === 0) {
        notices.push({
          code: "NO_HEADER_ROW",
          count: 1,
          examples: [],
          detail: `Tab '${sheetName}' không có dòng tiêu đề nào đọc được — kiểm tra lại tên tab hoặc quyền truy cập.`,
        });
      }

      deps.logger.child({ tenant_id: tenantId }).info("Catalog text read from Google Sheet", {
        spreadsheet_id: spreadsheetId,
        sheet_name: sheetName,
        columns: snapshot.columns.length,
        rows: snapshot.rows.length,
        duplicate_columns: snapshot.duplicateColumns,
      });

      return {
        snapshot,
        format: { source: SHEET_TEXT_SOURCE_ID, delimiter: null, encoding: null, detected: false },
        notices,
      };
    },
  };
}
