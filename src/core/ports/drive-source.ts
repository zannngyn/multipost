/**
 * Google Drive port (E2). Core declares the need; adapters/google implements it.
 * Pure TypeScript: no imports (docs/07 section 2).
 *
 * Contract for implementers:
 * - Return ONLY files of the requested folder, sub-folders excluded (docs/05
 *   section 3: the two readable sub-folders are out of the automated flow).
 * - Every field must be schema-validated at the adapter before it is returned;
 *   a file without an id or a name is dropped there, not here.
 * - Any transport/permission failure surfaces as AppError('DRIVE_ERROR') with
 *   `tenant_id` + `folder_id` in its context. Never leak a googleapis error.
 */

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

export interface DriveSource {
  listFiles(input: ListDriveFilesInput): Promise<readonly DriveFile[]>;
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
