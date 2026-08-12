import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/** Mirrors MEDIA_KINDS in core/domain/media-file-name.ts — keep both in sync. */
export const mediaKindEnum = pgEnum("media_kind", ["image", "video"]);

/**
 * One Drive file attached to a product code.
 *
 * Identity is the Drive file id, not the name: 1,499 names are used by several
 * files (docs/05 section 1.4). `sequence` is nullable because 1,063 real files
 * carry no `(n)`, and `color` is nullable because ~1,000 carry no colour —
 * dropping them would hide a fifth of the folder from the operator.
 */
export const mediaAssets = pgTable(
  "media_asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    driveFileId: text("drive_file_id").notNull(),
    /** Whitespace-normalised file name. */
    fileName: text("file_name").notNull(),
    productCode: text("product_code").notNull(),
    /** Canonical colour ("XANH THAN"); null when the name carries none. */
    color: text("color"),
    /** Colour exactly as written in the file name. */
    colorRaw: text("color_raw"),
    sequence: integer("sequence"),
    kind: mediaKindEnum("kind").notNull(),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    realPhoto: boolean("real_photo").notNull().default(false),
    backView: boolean("back_view").notNull().default(false),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    modifiedTime: timestamp("modified_time", { withTimezone: true, mode: "date" }),
    /** File-name deviations, so the UI can explain the "needs review" badge. */
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    needsReview: boolean("needs_review").notNull().default(false),
    /** Last sync that saw this file. See the note on product.last_sync_run_id. */
    lastSyncRunId: uuid("last_sync_run_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("media_asset_tenant_file_uq").on(table.tenantId, table.driveFileId),
    // Album building: every read is "this tenant, this code, ordered by number".
    index("media_asset_tenant_code_seq_idx").on(table.tenantId, table.productCode, table.sequence),
    index("media_asset_tenant_sync_run_idx").on(table.tenantId, table.lastSyncRunId),
  ],
);

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type NewMediaAssetRow = typeof mediaAssets.$inferInsert;
