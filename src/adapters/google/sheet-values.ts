import { buildCatalogSnapshot } from "@/core/domain/catalog-snapshot";
import type { SheetSnapshot } from "@/core/ports/sheet-source";

/**
 * Grid (header row + data rows) -> SheetSnapshot.
 *
 * The rules moved to `core/domain/catalog-snapshot` when an uploaded CSV became
 * a second source of the same snapshot (onboarding phase 3) — two adapters must
 * not each own a copy of "how a table becomes rows". This name stays as the
 * Sheets adapter's door to it.
 */
export function buildSheetSnapshot(grid: readonly (readonly string[])[]): SheetSnapshot {
  return buildCatalogSnapshot(grid);
}
