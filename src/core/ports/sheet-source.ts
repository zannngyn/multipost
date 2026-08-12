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

export interface SheetRow {
  /** 1-based row number in the spreadsheet (the header is row 1). */
  readonly rowNumber: number;
  /** Column name -> trimmed cell text. Missing cells are absent, not null. */
  readonly values: Readonly<Record<string, string>>;
}

export interface SheetSnapshot {
  /** Header names in sheet order, blanks removed. */
  readonly columns: readonly string[];
  /** Headers that appeared more than once — reported, never guessed. */
  readonly duplicateColumns: readonly string[];
  readonly rows: readonly SheetRow[];
}

export interface ReadSheetInput {
  readonly tenantId: string;
  readonly spreadsheetId: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName: string;
}

export interface SheetSource {
  readRows(input: ReadSheetInput): Promise<SheetSnapshot>;
}
