import type { SheetRow, SheetSnapshot } from "@/core/ports/sheet-source";

/**
 * Grid (header row + data rows) -> SheetSnapshot. Shared by the Sheets adapter
 * and the sample-data fixture so both produce exactly the same shape.
 *
 * Rules (docs/05 section 2.1):
 * - columns are addressed BY NAME; blank headers are dropped (the real tab has
 *   many unnamed trailing columns),
 * - a header repeated later keeps its FIRST column and is reported,
 * - `rowNumber` is the 1-based spreadsheet row so an operator can jump to it.
 */
export function buildSheetSnapshot(grid: readonly (readonly string[])[]): SheetSnapshot {
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

  const rows: SheetRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i] ?? [];
    const values: Record<string, string> = {};
    for (const [name, index] of indexByName) {
      const cell = cells[index];
      values[name] = typeof cell === "string" ? cell.trim() : "";
    }
    rows.push({ rowNumber: i + 1, values });
  }

  return { columns, duplicateColumns, rows };
}
