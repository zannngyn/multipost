import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import type { PostJobMedia } from "@/core/domain/post-job";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { postBatches } from "./post-batch";

/** Mirrors POST_JOB_STATUSES in core/domain/post-job.ts — keep both in sync. */
export const postJobStatusEnum = pgEnum("post_job_status", [
  "draft",
  "queued",
  "publishing",
  "published",
  "failed",
  "blocked",
]);

/**
 * ONE post on ONE channel (business rule 6). The centre of the system.
 *
 * ANTI-DUPLICATE LOCK (business rule 4, docs/02 §4): the unique index on
 * (tenant_id, batch_id, product_code, color, channel_id, format). It is taken
 * when the batch is created — before any publish call can exist — so a worker
 * that dies mid-publish and a job that runs again cannot produce two posts.
 * `color` and `format` are NOT NULL for exactly this reason: in Postgres
 * NULL != NULL, so a nullable column would silently disable the constraint.
 *
 * Runtime half of the same protection: the state machine. A worker only moves
 * `queued -> publishing` with an optimistic UPDATE ... WHERE status = 'queued',
 * and `published` never transitions again.
 */
export const postJobs = pgTable(
  "post_job",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => postBatches.id, { onDelete: "cascade" }),
    productCode: text("product_code").notNull(),
    /** "" = every colour of the code. See the note above on NOT NULL. */
    color: text("color").notNull().default(""),
    /** Tenant-side channel id (tenant_integration.config), e.g. "fbpage-a". */
    channelId: text("channel_id").notNull(),
    format: text("format").notNull().default("image_post"),
    status: postJobStatusEnum("status").notNull().default("draft"),
    /** Publish attempts started; incremented on each `-> publishing`. */
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    /** Vietnamese operator message — "why is this post not live?". */
    lastErrorMessage: text("last_error_message"),
    /** Platform post id. Its presence IS the proof a post exists. */
    publishedPostId: text("published_post_id"),
    publishedUrl: text("published_url"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    captionText: text("caption_text").notNull(),
    /** Ordered album; index 0 is the cover. */
    media: jsonb("media").$type<PostJobMedia[]>().notNull().default([]),
    /** Phase 2 scheduling; stored now so the column does not move later. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    unique("post_job_duplicate_uq").on(
      table.tenantId,
      table.batchId,
      table.productCode,
      table.color,
      table.channelId,
      table.format,
    ),
    index("post_job_tenant_status_idx").on(table.tenantId, table.status),
    index("post_job_tenant_batch_idx").on(table.tenantId, table.batchId),
    // Spacing gate: "when did this channel last publish?" (brief §6).
    index("post_job_tenant_channel_published_idx").on(
      table.tenantId,
      table.channelId,
      table.publishedAt,
    ),
  ],
);

export type PostJobRow = typeof postJobs.$inferSelect;
export type NewPostJobRow = typeof postJobs.$inferInsert;
