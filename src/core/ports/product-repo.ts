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
import type { TenantId } from "@/core/domain/tenant-context";

export interface ProductRepo {
  findByCode(tenantId: TenantId, code: string): Promise<Product | null>;
  /** Insert or update by (tenant, code). Returns the number of rows written. */
  upsertMany(tenantId: TenantId, products: readonly Product[], syncRunId: string): Promise<number>;
  /** Removes products not touched by `syncRunId`. Returns rows deleted. */
  deleteStale(tenantId: TenantId, syncRunId: string): Promise<number>;
  /**
   * How many products this tenant currently has. Read by the sync BEFORE
   * `deleteStale`: a sheet that suddenly parses to zero rows while the catalog
   * holds hundreds is a permission/tab problem, not an emptied shop, and the
   * difference is only visible by comparing the two numbers.
   */
  countAll(tenantId: TenantId): Promise<number>;
}

/** One row the E9.4 sweep may remove. Carries its tenant: the sweep has none. */
export interface OrphanedUpload {
  readonly tenantId: TenantId;
  readonly assetId: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly sizeBytes: number | null;
}

export interface MediaRepo {
  listByProductCode(tenantId: TenantId, code: string): Promise<readonly MediaAsset[]>;
  /** Insert or update by (tenant, drive file id). Returns rows written. */
  upsertMany(tenantId: TenantId, assets: readonly MediaAsset[], syncRunId: string): Promise<number>;
  /**
   * Removes Drive rows the given sync did not see. MUST leave uploaded rows
   * alone — they belong to no sync run (E9).
   */
  deleteStale(tenantId: TenantId, syncRunId: string): Promise<number>;
  /**
   * How many Drive-origin assets this tenant currently has — the exact set
   * `deleteStale` may remove. Uploaded rows are excluded because no sync run
   * can delete them. Read before `deleteStale` for the same reason as
   * `ProductRepo.countAll`: an empty Drive listing is what a lost permission
   * looks like (files.list answers HTTP 200 with `files: []`, not 403).
   */
  countDriveAssets(tenantId: TenantId): Promise<number>;

  // --- E9 (mode B) ---------------------------------------------------------

  /**
   * Records one operator-uploaded asset. Separate from `upsertMany` on purpose:
   * that one is the sync writer and stamps a run id, which an upload must never
   * carry, or the next sync would sweep it away.
   */
  registerUpload(tenantId: TenantId, asset: MediaAsset): Promise<void>;

  /**
   * E9.4 — uploaded assets created before `olderThan` that no post job
   * references, so the cleanup sweep can delete their bytes and their rows.
   *
   * Cross-tenant like `PostJobRepo.findStalePublishing`, and for the same
   * reason: a maintenance sweep has no tenant of its own to run as. Each row
   * therefore carries its own `tenantId`, and the DELETE below is tenant-scoped
   * again.
   */
  listOrphanedUploads(input: {
    olderThan: Date;
    limit: number;
  }): Promise<readonly OrphanedUpload[]>;

  /**
   * Uploads of ONE product code that no post job references yet — regardless of
   * age. `uploadMedia` clears these before storing a new album, so a second
   * upload for the same code replaces the abandoned one instead of merging
   * with it and producing duplicate sequence numbers.
   *
   * Referenced uploads are deliberately excluded: a scheduled post still needs
   * its rows to resolve a signed media URL.
   */
  listUnreferencedUploadsForCode(
    tenantId: TenantId,
    productCode: string,
  ): Promise<readonly OrphanedUpload[]>;

  /** Removes uploaded rows by asset id. Returns how many were removed. */
  deleteUploads(tenantId: TenantId, assetIds: readonly string[]): Promise<number>;
}

// --- Sync run ---------------------------------------------------------------

export const SYNC_RUN_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/**
 * One skipped/odd item of a sync run. This is the record that answers "why is
 * this photo not in the picker?" without opening a log file (business rule 5).
 */
export interface SyncIssue {
  /**
   * Machine code the issue is grouped by — English, stable, and severity-bearing
   * (FILE_NAME_INVALID = dropped, FILE_DUPLICATE = fine, FILE_NEEDS_REVIEW =
   * kept but worth a look). Some codes match an AppError code, others exist only
   * on the sync report.
   */
  readonly errorCode: string;
  /** Finer-grained machine reason, e.g. MULTIPLE_PRODUCT_CODES / MISSING_NAME. */
  readonly reason: string;
  /** File name or sheet row reference the issue is about. */
  readonly ref: string;
  /** Sentence for the OPERATOR — Vietnamese (CLAUDE.md technical rule 6). */
  readonly detail: string;
}

/**
 * All issues of one `errorCode`, counted BEFORE the `issues[]` cap is applied.
 * This is what lets the screen say "4.812 file sai tên" while storing three
 * examples of it — the capped list alone could only ever say "200".
 */
export interface SyncIssueGroup {
  readonly errorCode: string;
  /** Exact number detected by the run — never truncated. */
  readonly count: number;
  /** First few issues of the group, kept for the "ví dụ" panel. */
  readonly examples: readonly SyncIssue[];
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
  readonly tenantId: TenantId;
  readonly source: {
    readonly driveFolderId: string;
    readonly spreadsheetId: string;
    readonly sheetName: string;
  };
  readonly startedAt: Date;
}

export interface FinishSyncRunInput {
  readonly tenantId: TenantId;
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  readonly finishedAt: Date;
  readonly counts: SyncRunCounts;
  /** Capped by the usecase — a run must not write 1,500 rows of JSON. */
  readonly issues: readonly SyncIssue[];
  /** One row per error code, with EXACT counts. Bounded by the code vocabulary. */
  readonly issueGroups: readonly SyncIssueGroup[];
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
  /**
   * Null for a run written before the column existed, and while the run is
   * still `running`. Every reader must handle that null — old rows are NOT
   * back-filled.
   */
  readonly issueGroups: readonly SyncIssueGroup[] | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * One line of the run history rail. Deliberately WITHOUT `issues`/`issueGroups`:
 * a five-row list must not drag thousands of JSON rows across the wire.
 */
export interface SyncRunListItem {
  readonly id: string;
  readonly status: SyncRunStatus;
  readonly startedAt: Date;
  /** Null while the run is still `running`, or when it crashed mid-way. */
  readonly finishedAt: Date | null;
  /** Null when the run wrote no counts yet (`running`/crashed before finish). */
  readonly issuesTotal: number | null;
  readonly errorCode: string | null;
}

export interface SyncRunRepo {
  /** Creates the row up front so a crash still leaves a `running` trace. */
  start(input: StartSyncRunInput): Promise<{ id: string }>;
  finish(input: FinishSyncRunInput): Promise<void>;
  /** Newest run by `startedAt`, or null when the tenant never synced. */
  findLatest(tenantId: TenantId): Promise<SyncRunSummary | null>;
  /**
   * Newest `limit` runs by `startedAt` (descending), newest first. The caller
   * has already bounded `limit`; the adapter still refuses a non-positive one.
   */
  listRecent(tenantId: TenantId, limit: number): Promise<readonly SyncRunListItem[]>;
}

// --- Catalog read model (E2/E3 "nguồn dữ liệu + sản phẩm") -------------------

/**
 * Why a SEPARATE port instead of more methods on ProductRepo: this is a read
 * model for one screen (list + counters), and its rows carry media counts that
 * the write-side repo has no business knowing. Keeping it apart also means the
 * sync/publish fakes do not grow methods they never call.
 *
 * Implemented by adapters/db (DrizzleProductRepo). Same contract as every other
 * repo: tenant-scoped, AppError('DB_ERROR') on driver failures.
 */

/** One product row plus the media tally the screen shows next to it. */
export interface CatalogProductRow {
  readonly code: string;
  readonly name: string;
  readonly category: string | null;
  readonly season: string | null;
  /** `Tồn` verbatim — the decision table parses it, the adapter must not. */
  readonly stockRaw: string;
  /** `Lưu ý` verbatim. */
  readonly noteRaw: string;
  readonly hasConflict: boolean;
  readonly mediaImageCount: number;
  readonly mediaVideoCount: number;
}

export interface ListCatalogProductsQuery {
  readonly tenantId: TenantId;
  /**
   * Free text matched against code and name, case-insensitively. The ADAPTER
   * escapes LIKE wildcards: a user typing `%` searches for a percent sign.
   */
  readonly search?: string;
  /** Rows to read; the usecase has already capped it. */
  readonly limit: number;
  /** Keyset: return codes strictly AFTER this one (ascending order). */
  readonly afterCode?: string;
}

export interface CatalogProductPage {
  /** Ordered by `code` ascending. */
  readonly items: readonly CatalogProductRow[];
  /** Last code of the page when more rows may follow, else null. */
  readonly nextAfterCode: string | null;
}

/**
 * Counting bucket: every product sharing these four signals lands in one row,
 * so the totals are computed by SQL (GROUP BY) while the decision table itself
 * stays in core — duplicating the stock rules in SQL is exactly the drift the
 * brief forbids.
 */
export interface CatalogSignalGroup {
  readonly stockRaw: string;
  readonly noteRaw: string;
  readonly hasConflict: boolean;
  readonly hasMedia: boolean;
  readonly count: number;
}

export interface CatalogReadRepo {
  listCatalog(query: ListCatalogProductsQuery): Promise<CatalogProductPage>;
  /** Same filter as `listCatalog`, minus paging: one row per signal bucket. */
  aggregateCatalog(query: {
    readonly tenantId: TenantId;
    readonly search?: string;
  }): Promise<readonly CatalogSignalGroup[]>;
}
