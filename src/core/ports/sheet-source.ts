import type { CatalogRow, CatalogSnapshot } from "@/core/domain/catalog-snapshot";
import type { TenantId } from "@/core/domain/tenant-context";
/**
 * Google Sheets port (E2). Core declares the need; adapters/google implements it.
 * Pure TypeScript: no imports (docs/07 section 2).
 *
 * Contract for implementers:
 * - Rows are keyed BY COLUMN NAME taken from the header row, never by position
 *   (docs/05 section 2.1). Blank header cells are dropped; a duplicated header
 *   keeps its first occurrence and is reported in `duplicateColumns`.
 * - `rowNumber` is the 1-based spreadsheet row, header included, so an operator
 *   can jump straight to the offending line.
 * - Failures surface as AppError('SHEET_ERROR') with `tenant_id` +
 *   `spreadsheet_id` + `sheet_name` in the context.
 */

/**
 * Aliases of the format-agnostic snapshot types (core/domain/catalog-snapshot).
 * They are the SAME types, not copies: since onboarding phase 3 a snapshot can
 * also come from an uploaded CSV, and the field map / parser must not be able
 * to tell the two apart. Kept under these names so every existing import keeps
 * working — a sheet-specific alias is still the clearest name at a call site
 * that really does read a sheet.
 */
export type SheetRow = CatalogRow;
export type SheetSnapshot = CatalogSnapshot;

export interface ReadSheetInput {
  readonly tenantId: TenantId;
  readonly spreadsheetId: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName: string;
}

export interface SheetSource {
  readRows(input: ReadSheetInput): Promise<SheetSnapshot>;
}
