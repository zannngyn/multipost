import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * A file that has been handed a pre-signed upload URL but has NOT yet been
 * vetted (type/size checked, confirmed).
 *
 * Deliberately a table of its own, not a state column on `media_asset`: if a
 * ticket lived in `media_asset`, every existing media query (compose, product
 * listing, preview) would need a new filter, and missing ONE would let an
 * un-vetted file reach a published post. A separate table makes that failure
 * impossible rather than unlikely.
 */
export const uploadTickets = pgTable(
  "upload_ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    /** Asset identifier; becomes `media_asset.drive_file_id` after confirm. */
    assetId: text("asset_id").notNull(),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    declaredMime: text("declared_mime").notNull(),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    productCode: text("product_code").notNull(),
    createdBy: text("created_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    // Confirm looks up by (tenant, asset); the sweep scans by expires_at.
    index("upload_ticket_tenant_asset_idx").on(table.tenantId, table.assetId),
    index("upload_ticket_expires_idx").on(table.expiresAt),
  ],
);

export type UploadTicketRow = typeof uploadTickets.$inferSelect;
export type NewUploadTicketRow = typeof uploadTickets.$inferInsert;
