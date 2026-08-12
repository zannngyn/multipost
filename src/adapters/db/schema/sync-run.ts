import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { SyncIssue, SyncRunCounts } from "@/core/ports/product-repo";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/** Mirrors SYNC_RUN_STATUSES in core/ports/product-repo.ts — keep both in sync. */
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "running",
  "succeeded",
  "partial",
  "failed",
]);

/**
 * One Drive+Sheet sync. `counts` and `issues` are the audit trail that answers
 * "why is this photo/product missing?" without reading a log file
 * (CLAUDE.md business rule 5). `issues` is capped by the usecase.
 */
export const syncRuns = pgTable(
  "sync_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    status: syncRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    /** { driveFolderId, spreadsheetId, sheetName } used by this run. */
    source: jsonb("source").$type<Record<string, string>>().notNull(),
    counts: jsonb("counts").$type<SyncRunCounts | null>(),
    issues: jsonb("issues").$type<SyncIssue[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    ...timestamps,
  },
  (table) => [index("sync_run_tenant_started_idx").on(table.tenantId, table.startedAt)],
);

export type SyncRunRow = typeof syncRuns.$inferSelect;
export type NewSyncRunRow = typeof syncRuns.$inferInsert;
