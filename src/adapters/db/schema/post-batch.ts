import { index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { users } from "./user";

/** Mirrors POST_BATCH_STATUSES in core/domain/post-job.ts — keep both in sync. */
export const postBatchStatusEnum = pgEnum("post_batch_status", [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
]);

/**
 * One click of "post": a product (optionally one colour) fanned out to N
 * channels. `status` is DERIVED from its jobs by `deriveBatchStatus` and
 * rewritten by the repo — it is a cached read model, never an independent truth.
 *
 * The id is supplied by the caller: it is the idempotency scope of the
 * anti-duplicate lock on post_job (business rule 4). Re-running a batch
 * creation with the same id hits that unique index instead of posting twice.
 */
export const postBatches = pgTable(
  "post_batch",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    productCode: text("product_code").notNull(),
    /** "" = every colour of the code. NOT NULL so the unique key can compare it. */
    color: text("color").notNull().default(""),
    /** 'image_post' in Phase 1; 'video_post'/'reels' arrive in Phase 2. */
    format: text("format").notNull().default("image_post"),
    status: postBatchStatusEnum("status").notNull().default("pending"),
    note: text("note"),
    /** Null for system/worker-created batches. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("post_batch_tenant_created_idx").on(table.tenantId, table.createdAt)],
);

export type PostBatchRow = typeof postBatches.$inferSelect;
export type NewPostBatchRow = typeof postBatches.$inferInsert;
