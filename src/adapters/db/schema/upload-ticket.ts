import { bigint, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
    // An asset_id names exactly one stored object: two ticket rows for the
    // same (tenant, asset) is never legitimate. UNIQUE (not just an index)
    // so a retried/duplicate createMany fails loudly instead of leaving a
    // second, orphaned ticket that confirm's Map-by-assetId would silently
    // drop. This constraint's own index also serves confirm's lookup, so
    // the plain index this replaced is gone.
    unique("upload_ticket_tenant_asset_uq").on(table.tenantId, table.assetId),
    // The expiry sweep scans by expires_at alone, across every tenant.
    index("upload_ticket_expires_idx").on(table.expiresAt),
  ],
);

export type UploadTicketRow = typeof uploadTickets.$inferSelect;
export type NewUploadTicketRow = typeof uploadTickets.$inferInsert;
