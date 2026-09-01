import { boolean, index, jsonb, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/** Mirrors PRODUCT_ORIGINS in core/domain/product.ts — keep both in sync. */
export const productOriginEnum = pgEnum("product_origin", ["sheet", "manual"]);

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

    /**
     * Where the text came from. `sheet` = a synced catalog row (Google tab or
     * uploaded CSV), `manual` = typed by an operator on the compose screen
     * (onboarding phase 3). Default keeps every existing row a synced one.
     */
    origin: productOriginEnum("origin").notNull().default("sheet"),

    /** True when several sheet rows for this code disagree — blocks posting. */
    hasConflict: boolean("has_conflict").notNull().default(false),
    /** 1-based sheet rows this snapshot came from. */
    sourceRows: jsonb("source_rows").$type<number[]>().notNull().default([]),
    /**
     * Last sync that saw this product. No FK on purpose: sync_run rows are
     * prunable history, products must survive their retention.
     *
     * NULL for a `manual` row: it belongs to no run, which is exactly what
     * keeps `deleteStale` from sweeping away a product an operator typed (same
     * shape as an uploaded media asset).
     */
    lastSyncRunId: uuid("last_sync_run_id"),
    ...timestamps,
  },
  (table) => [
    unique("product_tenant_code_uq").on(table.tenantId, table.code),
    index("product_tenant_sync_run_idx").on(table.tenantId, table.lastSyncRunId),
    index("product_tenant_origin_idx").on(table.tenantId, table.origin),
  ],
);

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
