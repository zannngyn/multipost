/**
 * Catalog persistence ports (E2/E3). Core declares the need; adapters/db
 * implements them. Pure TypeScript: types only (docs/07 section 2).
 *
 * Contract for every implementer:
 * - Every method is tenant-scoped through the tenant-scope helper (business
 *   rule 7); a missing/invalid tenant id throws AppError('INVALID_INPUT').
 * - Driver failures surface as AppError('DB_ERROR') carrying `tenant_id` and
 *   the operation name; a driver error must never escape raw.
 * - `syncRunId` stamps every write so a later `deleteStale` can remove rows the
 *   latest sync did not see — that is how a file deleted on Drive disappears.
 */

import type { MediaAsset, Product } from "@/core/domain/product";

export interface ProductRepo {
  findByCode(tenantId: string, code: string): Promise<Product | null>;
  /** Insert or update by (tenant, code). Returns the number of rows written. */
  upsertMany(tenantId: string, products: readonly Product[], syncRunId: string): Promise<number>;
  /** Removes products not touched by `syncRunId`. Returns rows deleted. */
  deleteStale(tenantId: string, syncRunId: string): Promise<number>;
}

export interface MediaRepo {
  listByProductCode(tenantId: string, code: string): Promise<readonly MediaAsset[]>;
  /** Insert or update by (tenant, drive file id). Returns rows written. */
  upsertMany(tenantId: string, assets: readonly MediaAsset[], syncRunId: string): Promise<number>;
  deleteStale(tenantId: string, syncRunId: string): Promise<number>;
}

// --- Sync run ---------------------------------------------------------------

export const SYNC_RUN_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/**
 * One skipped/odd item of a sync run. This is the record that answers "why is
 * this photo not in the picker?" without opening a log file (business rule 5).
 */
export interface SyncIssue {
  /** AppError code the issue maps to, e.g. FILE_NAME_INVALID. */
  readonly errorCode: string;
  /** Finer-grained reason, e.g. MULTIPLE_PRODUCT_CODES / MISSING_NAME. */
  readonly reason: string;
  /** File name or sheet row reference the issue is about. */
  readonly ref: string;
  readonly detail: string;
}

export interface SyncRunCounts {
  readonly driveFilesSeen: number;
  readonly mediaParsed: number;
  readonly mediaRejected: number;
  readonly mediaDuplicatesDropped: number;
  readonly mediaNeedingReview: number;
  readonly sheetRowsSeen: number;
  readonly productsParsed: number;
  readonly sheetRowsRejected: number;
  readonly productsWithConflict: number;
  readonly productsWithoutMedia: number;
  readonly mediaWithoutProduct: number;
  readonly productsWritten: number;
  readonly mediaWritten: number;
  readonly productsDeleted: number;
  readonly mediaDeleted: number;
  /** Issues DETECTED by the run — `issues[]` is capped, this number is not. */
  readonly issuesTotal: number;
  /** True when `issues[]` holds fewer entries than `issuesTotal`. */
  readonly issuesTruncated: boolean;
}

export interface StartSyncRunInput {
  readonly tenantId: string;
  readonly source: {
    readonly driveFolderId: string;
    readonly spreadsheetId: string;
    readonly sheetName: string;
  };
  readonly startedAt: Date;
}

export interface FinishSyncRunInput {
  readonly tenantId: string;
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  readonly finishedAt: Date;
  readonly counts: SyncRunCounts;
  /** Capped by the usecase — a run must not write 1,500 rows of JSON. */
  readonly issues: readonly SyncIssue[];
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

/**
 * Read model behind "when did this tenant last sync, and how did it go?"
 * (E2 status panel). Dates stay Dates here; formatting is the usecase's job.
 */
export interface SyncRunSummary {
  readonly id: string;
  readonly status: SyncRunStatus;
  readonly startedAt: Date;
  /** Null while the run is still `running` — a crashed run never gets one. */
  readonly finishedAt: Date | null;
  /** Null until the run finishes; `counts` is written by `finish`. */
  readonly counts: SyncRunCounts | null;
  readonly issues: readonly SyncIssue[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface SyncRunRepo {
  /** Creates the row up front so a crash still leaves a `running` trace. */
  start(input: StartSyncRunInput): Promise<{ id: string }>;
  finish(input: FinishSyncRunInput): Promise<void>;
  /** Newest run by `startedAt`, or null when the tenant never synced. */
  findLatest(tenantId: string): Promise<SyncRunSummary | null>;
}
