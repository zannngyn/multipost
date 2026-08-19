import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./_tenant-column";
import { postJobs } from "./post-job";

/**
 * E7.5 — the durable half of job progress (design §5.4): one row per STAGE
 * CHANGE of a post job, roughly 6-8 rows per post.
 *
 * Its own append-only table instead of columns on `post_job`, for two reasons:
 *
 *  - `post_job` is the row a worker is holding while it publishes. An UPDATE per
 *    photo on that row is how you invent contention for nothing.
 *  - "which step was slow in yesterday's batch?" is a question about DURATIONS.
 *    A "latest stage" column cannot answer it; rows with `occurred_at` can.
 *
 * No `updated_at`: rows are never modified. The live per-photo detail lives in
 * Redis and is allowed to disappear (design §3.1) — this table is what remains.
 */
export const postJobEvents = pgTable(
  "post_job_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    postJobId: uuid("post_job_id")
      .notNull()
      .references(() => postJobs.id, { onDelete: "cascade" }),
    /** Denormalised on purpose: the batch screen reads by batch, not by job. */
    batchId: uuid("batch_id").notNull(),
    /** A PostJobStage value (core/domain/post-job-progress). */
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull().default(0),
    /** Numbers of that milestone: `{ done, total }`, `{ wait_ms }`... */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    /** Worker clock at the moment of the change — not the insert time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    // "the timeline of THIS post" — the shape of the detail screen's query.
    index("post_job_event_tenant_job_idx").on(table.tenantId, table.postJobId, table.occurredAt),
    // "where did yesterday's batch get stuck?" — one batch, in time order.
    index("post_job_event_tenant_batch_idx").on(table.tenantId, table.batchId, table.occurredAt),
  ],
);

export type PostJobEventRow = typeof postJobEvents.$inferSelect;
export type NewPostJobEventRow = typeof postJobEvents.$inferInsert;
