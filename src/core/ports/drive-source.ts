/**
 * Google Drive port (E2/E3). Core declares the need; adapters implement it.
 * Types only — no runtime import (docs/07 section 2).
 *
 * Contract for implementers:
 * - `listFiles` returns ONLY files of the requested folder, sub-folders
 *   excluded (docs/05 section 3: the two readable sub-folders are out of the
 *   automated flow). This stays the DEFAULT: it is one query per page, and no
 *   tenant should pay for a crawl their layout does not need.
 * - `listFilesDeep` (phase 2, OPTIONAL) walks sub-folders for the tenants who
 *   keep one folder per product code. It is capped in three dimensions (depth,
 *   folders, files) and MUST report every cap it hits in `limitsHit` — a
 *   silently truncated listing reads as "these files were deleted" to
 *   `syncCatalog.deleteStale`. Implementers batch several parents into ONE
 *   Drive query: a request per folder is how a 5,500-file folder burns the
 *   tenant's Drive quota.
 * - Every field must be schema-validated at the adapter before it is returned;
 *   a file without an id or a name is dropped there, not here.
 * - Any transport/permission failure surfaces as AppError('DRIVE_ERROR') with
 *   `tenant_id` + `folder_id` in its context. Never leak a googleapis error.
 * - `download` maps "the file is gone / not visible" to MEDIA_NOT_FOUND and
 *   everything else to DRIVE_ERROR, so the caller can tell a 404 from an outage.
 */

import type { CatalogFieldMap, StockPolicy } from "@/core/domain/catalog-field-map";
import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import type { MediaProfile } from "@/core/domain/media-profile";
import type { MediaAsset } from "@/core/domain/product";
import type { TenantId } from "@/core/domain/tenant-context";

export interface DriveFile {
  /** Drive file id — the stable identity (1,499 names are ambiguous). */
  readonly id: string;
  readonly name: string;
  /** Drive mime type, e.g. `image/jpeg`. Null when Drive omitted it. */
  readonly mimeType: string | null;
  /** Bytes, null for files Drive does not report a size for. */
  readonly sizeBytes: number | null;
  /** ISO-8601 timestamp; used to pick a winner among duplicate names. */
  readonly modifiedTime: string | null;
  /**
   * Folder the file sits in. Only filled by `listFilesDeep`: a flat listing
   * already knows the answer (the folder that was asked for), and adding it
   * there would change a value every existing caller compares.
   */
  readonly parentFolderId?: string | null;
  /**
   * Folder names from the requested root DOWN to the parent, root excluded.
   * `[]` = the file sits directly in the requested folder. This is what the
   * `folder-per-code` media profile reads the product code from.
   */
  readonly folderPath?: readonly string[];
}

export interface ListDriveFilesInput {
  readonly tenantId: TenantId;
  readonly folderId: string;
  /** Safety valve for tests/dev; the adapter still pages through Drive. */
  readonly maxFiles?: number;
}

/** Which cap ended a recursive listing early. */
export const DRIVE_LISTING_LIMITS = ["MAX_FILES", "MAX_FOLDERS", "MAX_DEPTH"] as const;
export type DriveListingLimit = (typeof DRIVE_LISTING_LIMITS)[number];

export interface ListDriveFilesDeepInput extends ListDriveFilesInput {
  /**
   * Levels BELOW the root to walk. 0 = flat. Default 2 (root -> folder per
   * code -> one grouping level inside it), which is as deep as any customer
   * layout seen so far, and the point where the query count stops being cheap.
   */
  readonly maxDepth?: number;
  /** Sub-folders visited before the walk stops and says so. */
  readonly maxFolders?: number;
}

/**
 * Result of a recursive listing. It is an object rather than an array because
 * "I stopped early" has to travel with the data: the caller decides whether a
 * truncated listing may be persisted (it must not be — see the empty-source
 * guard in syncCatalog).
 */
export interface DriveListing {
  readonly files: readonly DriveFile[];
  /** Sub-folders actually listed, root excluded. */
  readonly foldersVisited: number;
  /** Deepest level reached, root = 0. */
  readonly depthReached: number;
  /** Empty = the listing is complete. Anything else = it is PARTIAL. */
  readonly limitsHit: readonly DriveListingLimit[];
}

export interface DownloadDriveFileInput {
  readonly tenantId: TenantId;
  /** Drive file id, never a name. */
  readonly fileId: string;
  /** Refuse anything bigger instead of buffering it. 0/undefined = no cap. */
  readonly maxBytes?: number;
}

/**
 * File content, fully buffered. Bytes rather than a stream on purpose: Phase 1
 * serves photos (a few MB) and a Uint8Array keeps `core` free of Node stream
 * types. Revisit when Phase 2 streams video.
 */
export interface DriveFileContent {
  readonly fileId: string;
  readonly bytes: Uint8Array;
  /** From the HTTP response; null when Drive did not say. */
  readonly mimeType: string | null;
  readonly sizeBytes: number;
}

export interface DriveSource {
  listFiles(input: ListDriveFilesInput): Promise<readonly DriveFile[]>;
  /**
   * Recursive listing, OPTIONAL by design: only the Google adapter can do it,
   * and a caller must be able to work without it (fixtures, tests, and any
   * future source). A caller that needs it and does not have it must say so —
   * never fall back to the flat listing in silence, because for a
   * `folder-per-code` tenant that answers "0 file" while everything is fine.
   */
  listFilesDeep?(input: ListDriveFilesDeepInput): Promise<DriveListing>;
  /** Reads one file's bytes. Used by the signed media route (E3 -> E5). */
  download(input: DownloadDriveFileInput): Promise<DriveFileContent>;
}

/**
 * Resolves a media asset id back to the row synced from Drive.
 *
 * It sits next to DriveSource (like CatalogConfigRepo below) because it is the
 * database half of ONE question — "may this tenant read this Drive file?" — and
 * the answer must be tenant-scoped: the Service Account can read every folder,
 * so without this check a valid signature of tenant A would reach tenant B's
 * files. Implemented by adapters/db (DrizzleMediaRepo).
 */
export interface MediaAssetLookup {
  /** Null when the tenant has no synced asset with that Drive file id. */
  findByDriveFileId(tenantId: TenantId, driveFileId: string): Promise<MediaAsset | null>;
}

/**
 * Per-tenant Drive/Sheet coordinates. Read from `tenant_integration`
 * (CLAUDE.md business rule 7) — never from env, never hardcoded.
 */
export interface CatalogSourceConfig {
  /**
   * Photo folder. May be EMPTY for a tenant running on uploaded photos only
   * (phase 3): the sync then skips the media half and says so, instead of
   * reporting every product as "chưa có ảnh".
   */
  readonly driveFolderId: string;
  /** Empty when `textSource.kind` is "file" — that tenant has no spreadsheet. */
  readonly spreadsheetId: string;
  /** Tab name, e.g. "Mẫu 2026". Empty for a file source. */
  readonly sheetName: string;
  /**
   * Which column of THIS tenant's sheet holds which logical field.
   *
   * Absent = the MYSP preset (`MYSP_FIELD_MAP`) — what every tenant configured
   * before onboarding existed already has, so an old `tenant_integration` row
   * keeps working untouched. Implementers validate the stored blob (zod at the
   * adapter) and must NOT silently fall back to the preset on a broken one.
   */
  readonly fieldMap?: CatalogFieldMap;
  /**
   * How the `stock` column is read. Absent = `{ mode: "numeric" }`.
   * `disabled` suspends the stock gate for the tenant and therefore carries a
   * written reason — see StockPolicy.
   */
  readonly stockPolicy?: StockPolicy;
  /**
   * Where this tenant's photos are and how a file maps to a product code
   * (onboarding phase 2). Absent = `{ kind: "code-color-seq" }`, the internal
   * `MÃ-Màu (số).ext` convention — so an integration row written before phase 2
   * keeps syncing exactly as it did. Same rule as `fieldMap`: a stored profile
   * that does not parse is an error, never a silent fallback to the default.
   */
  readonly mediaProfile?: MediaProfile;
  /**
   * WHERE THE PRODUCT TEXT COMES FROM (onboarding phase 3). Absent =
   * `google_sheet`, i.e. read `spreadsheetId`/`sheetName` above — so every row
   * written before phase 3 syncs exactly as it did.
   *
   * `kind: "file"` points at a CSV the tenant uploaded, and then
   * `spreadsheetId`/`sheetName` are not required at all: that tenant may have no
   * Google account. `driveFolderId` becomes optional for the same reason — a
   * tenant can run entirely on uploaded photos (mode B), and the sync then only
   * refreshes the product table.
   */
  readonly textSource?: CatalogTextConfig;
}

export interface CatalogConfigRepo {
  /** Null when the tenant has no google integration row yet. */
  findCatalogConfig(tenantId: TenantId): Promise<CatalogSourceConfig | null>;
  /**
   * Read-model twin of `findCatalogConfig` for the "nguồn dữ liệu" panel.
   *
   * Difference, and the reason both exist: a half-filled or disabled
   * integration row must STOP a sync (findCatalogConfig throws, so nobody reads
   * an empty catalog as "nothing changed"), but it must only make the panel say
   * "chưa cấu hình" (this returns null and logs a warning). Same row, two
   * audiences, two verdicts.
   */
  findCatalogSource(tenantId: TenantId): Promise<CatalogSourceConfig | null>;
  /**
   * The stock policy alone, for the HOT PATH (compose / catalog list / publish).
   *
   * Third method on purpose, with a THIRD contract: it must never throw for a
   * tenant that simply has no google integration. A tenant running the
   * upload-only mode has no Drive row at all, and `composePost` dying because of
   * that would be a self-inflicted outage.
   *
   * Implementers MUST:
   *   - no integration row / disabled / incomplete coordinates -> `numeric`
   *     (the SAFE default: stock is still checked), logged at debug;
   *   - a stored `stockPolicy` that does not parse -> THROW with the same coded
   *     error as `findCatalogConfig` (MAPPING_INVALID). A broken policy must
   *     never degrade into "khỏi kiểm tồn" — that is the one silent fallback
   *     this whole feature is not allowed to have.
   */
  findStockPolicy(tenantId: TenantId): Promise<StockPolicy>;
  /**
   * The column mapping alone, for the HOT PATH (AI validation needs to know
   * which of the tenant's columns feed a caption).
   *
   * Symmetric to `findStockPolicy`, same three answers: no row / disabled /
   * no `fieldMap` key -> `MYSP_FIELD_MAP` (the preset, i.e. today's behaviour),
   * a stored map that does not parse -> coded error (MAPPING_INVALID), a
   * database failure -> DB error. Never a silent preset for a broken map:
   * reading a customer sheet with OUR column names finds nothing at best and
   * the wrong column at worst.
   */
  findFieldMap(tenantId: TenantId): Promise<CatalogFieldMap>;
  /**
   * Writes the three coordinates and returns what was there before (null on a
   * first configuration), so the caller can log/show the change.
   *
   * Implementers MUST: keep any other key of `tenant_integration.config`
   * untouched (a provider row is shared with future settings), and write the
   * audit row in the SAME transaction as the update — an unattributed source
   * change is the one thing nobody can reconstruct afterwards.
   */
  saveCatalogSource(input: SaveCatalogSourceInput): Promise<{
    readonly previous: CatalogSourceConfig | null;
  }>;
}

/**
 * A PATCH of the catalog source. Every key means the same three things:
 *
 *   absent  -> keep what is stored (merged inside the write transaction),
 *   present -> replace it wholesale,
 *   ""      -> for the three coordinates only: CLEAR it (a tenant who moved to
 *              an uploaded file and no longer keeps photos on Drive).
 *
 * The coordinates became optional to close a lost update: a caller that read
 * the current config, then sent it back unchanged alongside its own edit, would
 * overwrite whatever a CONCURRENT save had written in between — the classic
 * read-outside-the-lock race. Callers now send only what they mean to change,
 * and the merge happens under the advisory lock.
 */
export interface CatalogSourcePatch {
  readonly driveFolderId?: string;
  readonly spreadsheetId?: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName?: string;
  readonly fieldMap?: CatalogFieldMap;
  readonly stockPolicy?: StockPolicy;
  readonly mediaProfile?: MediaProfile;
  readonly textSource?: CatalogTextConfig;
}

export interface SaveCatalogSourceInput {
  readonly tenantId: TenantId;
  /**
   * What to change. Anything left undefined keeps its stored value — a save
   * that only changes the folder must not wipe a mapping somebody spent an
   * onboarding session building, and a save that only changes the mapping must
   * not revert a folder another operator moved one second earlier.
   */
  readonly source: CatalogSourcePatch;
  /** `app_user.id`, or null when the actor could not be resolved. */
  readonly actorUserId: string | null;
  /** Kept in the audit payload even when the id is unknown. */
  readonly actorEmail: string | null;
}
