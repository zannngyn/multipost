/**
 * Google Drive port (E2/E3). Core declares the need; adapters implement it.
 * Types only — no runtime import (docs/07 section 2).
 *
 * Contract for implementers:
 * - Return ONLY files of the requested folder, sub-folders excluded (docs/05
 *   section 3: the two readable sub-folders are out of the automated flow).
 * - Every field must be schema-validated at the adapter before it is returned;
 *   a file without an id or a name is dropped there, not here.
 * - Any transport/permission failure surfaces as AppError('DRIVE_ERROR') with
 *   `tenant_id` + `folder_id` in its context. Never leak a googleapis error.
 * - `download` maps "the file is gone / not visible" to MEDIA_NOT_FOUND and
 *   everything else to DRIVE_ERROR, so the caller can tell a 404 from an outage.
 */

import type { MediaAsset } from "@/core/domain/product";

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
}

export interface ListDriveFilesInput {
  readonly tenantId: string;
  readonly folderId: string;
  /** Safety valve for tests/dev; the adapter still pages through Drive. */
  readonly maxFiles?: number;
}

export interface DownloadDriveFileInput {
  readonly tenantId: string;
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
  findByDriveFileId(tenantId: string, driveFileId: string): Promise<MediaAsset | null>;
}

/**
 * Per-tenant Drive/Sheet coordinates. Read from `tenant_integration`
 * (CLAUDE.md business rule 7) — never from env, never hardcoded.
 */
export interface CatalogSourceConfig {
  readonly driveFolderId: string;
  readonly spreadsheetId: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName: string;
}

export interface CatalogConfigRepo {
  /** Null when the tenant has no google integration row yet. */
  findCatalogConfig(tenantId: string): Promise<CatalogSourceConfig | null>;
}
