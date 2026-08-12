import { boolean, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Snapshot of one row (or a merged group of rows) of tab "Mẫu 2026".
 *
 * The whitelist of brief section 2.2 is enforced by the columns themselves:
 * caption-safe fields (name/description/category/season) and internal fields
 * (stock/note) are stored, the four PRICE columns are NOT — they are never read
 * from the sheet, so they cannot leak into a prompt from here.
 *
 * `stock_raw` keeps the cell verbatim instead of an integer: an empty cell and a
 * junk cell are different reasons to block, and the decision table needs to say
 * which one it was.
 */
export const products = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    code: text("code").notNull(),

    // --- caption-safe (ProductContent) ---
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    season: text("season"),

    // --- internal only (ProductOperational) ---
    stockRaw: text("stock_raw").notNull().default(""),
    noteRaw: text("note_raw").notNull().default(""),
    colorsRaw: text("colors_raw").notNull().default(""),

    /** True when several sheet rows for this code disagree — blocks posting. */
    hasConflict: boolean("has_conflict").notNull().default(false),
    /** 1-based sheet rows this snapshot came from. */
    sourceRows: jsonb("source_rows").$type<number[]>().notNull().default([]),
    /**
     * Last sync that saw this product. No FK on purpose: sync_run rows are
     * prunable history, products must survive their retention.
     */
    lastSyncRunId: uuid("last_sync_run_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("product_tenant_code_uq").on(table.tenantId, table.code),
    index("product_tenant_sync_run_idx").on(table.tenantId, table.lastSyncRunId),
  ],
);

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
