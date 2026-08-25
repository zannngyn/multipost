/**
 * Onboarding phase 3 — where an uploaded catalog FILE lives between syncs.
 * Types only, no runtime import (docs/07 section 2).
 *
 * WHY IT IS NOT `MediaBlobStore`: that store holds post media, is swept by the
 * E9.4 orphan cleanup and is keyed by asset id. A catalog file is configuration
 * — exactly one live file per tenant, referenced by `tenant_integration.config`,
 * and it must survive every media sweep. One port each keeps the two lifecycles
 * from ever meeting.
 *
 * Contract for every implementer (same as MediaBlobStore, deliberately):
 * - `put` is the only writer of a storage key; callers treat the key as opaque;
 * - `get` returns null when the key is unknown — a file that is gone is not a
 *   retryable error, it is a fact the caller must report to the operator;
 * - every method is tenant-scoped, and a key from one tenant MUST NOT resolve
 *   under another (no path traversal, no shared prefix tricks);
 * - only the STORE failing (disk unreadable) raises AppError.
 */

import type { TenantId } from "@/core/domain/tenant-context";

export interface PutCatalogFileInput {
  readonly tenantId: TenantId;
  /** Original name — kept by the CALLER in config; the store only stores bytes. */
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface StoredCatalogFile {
  /** Opaque handle written into `tenant_integration.config`. */
  readonly storageKey: string;
  readonly sizeBytes: number;
}

export interface GetCatalogFileInput {
  readonly tenantId: TenantId;
  readonly storageKey: string;
  /** Refuse to buffer more than this many bytes. */
  readonly maxBytes: number;
}

export interface CatalogFileContent {
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
}

export interface CatalogFileStore {
  put(input: PutCatalogFileInput): Promise<StoredCatalogFile>;
  /** Null when the file is not there (never written, deleted, wrong tenant). */
  get(input: GetCatalogFileInput): Promise<CatalogFileContent | null>;
  /** True when a file was removed, false when there was nothing to remove. */
  delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean>;
}
