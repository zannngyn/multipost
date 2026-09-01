/**
 * The shape every product-text source produces (E2, onboarding phase 3).
 * Pure TypeScript: no imports, no I/O (docs/07 section 2).
 *
 * WHY IT LIVES IN `domain` NOW: a Google Sheet is no longer the only way a
 * tenant hands us their catalog — a customer without Google Workspace uploads a
 * CSV instead. Both must arrive as the SAME name-addressed snapshot, otherwise
 * `CatalogFieldMap` (phase 1) would need a second implementation per format,
 * which is exactly what splitting the field map out was meant to avoid.
 *
 * `SheetRow`/`SheetSnapshot` in core/ports/sheet-source are aliases of these
 * types, so every existing caller keeps compiling and keeps its meaning.
 *
 * Rules (docs/05 section 2.1):
 * - columns are addressed BY NAME; blank headers are dropped (the real tab has
 *   many unnamed trailing columns),
 * - a header repeated later keeps its FIRST column and is reported,
 * - `rowNumber` is the 1-based row a human sees in their spreadsheet (header
 *   is row 1), so an operator can jump straight to the offending line.
 */

export interface CatalogRow {
  /** 1-based row number in the source table (the header is row 1). */
  readonly rowNumber: number;
  /** Column name -> trimmed cell text. Missing cells are absent, not null. */
  readonly values: Readonly<Record<string, string>>;
}

export interface CatalogSnapshot {
  /** Header names in source order, blanks removed. */
  readonly columns: readonly string[];
  /** Headers that appeared more than once — reported, never guessed. */
  readonly duplicateColumns: readonly string[];
  readonly rows: readonly CatalogRow[];
}

export const EMPTY_CATALOG_SNAPSHOT: CatalogSnapshot = {
  columns: [],
  duplicateColumns: [],
  rows: [],
};

export interface BuildCatalogSnapshotOptions {
  /**
   * Row number of `grid[0]` as a HUMAN sees it in their spreadsheet. Default 1.
   *
   * It exists because a CSV reader may legitimately drop lines before the
   * header (Excel's `sep=;` directive, blank rows above a title block). Row
   * numbers must keep pointing at the line the operator will open, so the
   * dropped lines are counted here instead of silently shifting every message.
   */
  readonly firstRowNumber?: number;
}

/**
 * Grid (header row + data rows) -> snapshot. Shared by the Sheets adapter, the
 * uploaded-file adapter and the sample-data fixture so all three produce
 * exactly the same shape from the same table.
 */
export function buildCatalogSnapshot(
  grid: readonly (readonly string[])[],
  options: BuildCatalogSnapshotOptions = {},
): CatalogSnapshot {
  const header = grid[0] ?? [];
  const columns: string[] = [];
  const duplicateColumns: string[] = [];
  /** column name -> index in the grid. */
  const indexByName = new Map<string, number>();

  header.forEach((rawName, index) => {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length === 0) return;
    if (indexByName.has(name)) {
      if (!duplicateColumns.includes(name)) duplicateColumns.push(name);
      return;
    }
    indexByName.set(name, index);
    columns.push(name);
  });

  const firstRowNumber =
    Number.isInteger(options?.firstRowNumber) && (options.firstRowNumber as number) > 0
      ? (options.firstRowNumber as number)
      : 1;

  const rows: CatalogRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i] ?? [];
    const values: Record<string, string> = {};
    for (const [name, index] of indexByName) {
      const cell = cells[index];
      values[name] = typeof cell === "string" ? cell.trim() : "";
    }
    rows.push({ rowNumber: firstRowNumber + i, values });
  }

  return { columns, duplicateColumns, rows };
}
