/**
 * E9 (mode B) — where operator-uploaded bytes live.
 *
 * Mode A never needs this: Drive holds the file and `DriveSource.download`
 * fetches it. Mode B has no Drive file, so the bytes must be stored by us and
 * served back through the same signed media bridge, otherwise an uploaded post
 * could not publish at all (brief section 8: both modes share publishing).
 *
 * Deliberately a port with a tiny surface. The first implementation writes to a
 * Docker volume on the single VPS (docs/02); moving to object storage later is a
 * new adapter and nothing else — no core change, no usecase change.
 *
 * Contract for every implementer:
 * - `put` is the only writer of a storage key; callers treat the key as opaque.
 * - `get` returns null when the key is unknown, and throws AppError only when
 *   the STORE itself failed (disk unreadable) — a missing blob is not an error
 *   the caller should retry.
 * - Every method is tenant-scoped. An implementation MUST NOT let a key from one
 *   tenant resolve under another, and MUST reject keys that try to escape their
 *   tenant's area (path traversal).
 */

import type { MediaKind } from "@/core/domain/media-file-name";
import type { TenantId } from "@/core/domain/tenant-context";

export interface PutBlobInput {
  readonly tenantId: TenantId;
  /** Asset identity the blob belongs to — used to derive the key. */
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly kind: MediaKind;
}

export interface StoredBlob {
  /** Opaque handle persisted on the asset row; only the store parses it. */
  readonly storageKey: string;
  readonly sizeBytes: number;
}

export interface GetBlobInput {
  readonly tenantId: TenantId;
  readonly storageKey: string;
  /** Refuse to buffer more than this many bytes. */
  readonly maxBytes: number;
}

export interface BlobContent {
  readonly bytes: Uint8Array;
  readonly mimeType: string | null;
}

export interface CreateUploadUrlInput {
  readonly tenantId: TenantId;
  readonly assetId: string;
  /** Client-declared mime type; the signed policy is constrained to exactly this value. */
  readonly declaredMimeType: string;
  /** Byte ceiling baked into the policy itself, so storage rejects an oversized file on its own. */
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

/**
 * A POST policy, NOT a presigned PUT: only a POST policy can carry
 * `content-length-range`, which is what lets the bucket enforce the 25MB cap
 * without Node standing in the middle of the upload.
 */
export interface PresignedUpload {
  readonly postUrl: string;
  /** Attach to the FormData BEFORE the `file` field. */
  readonly formFields: Readonly<Record<string, string>>;
  /** Key of the object in the staging area. */
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export interface BlobStat {
  readonly sizeBytes: number;
  readonly mimeType: string | null;
}

export interface MediaBlobStore {
  put(input: PutBlobInput): Promise<StoredBlob>;
  /** Null when the blob is not there (deleted, never written, wrong tenant). */
  get(input: GetBlobInput): Promise<BlobContent | null>;
  /** True when a blob was removed, false when there was nothing to remove. Targets the SERVING area. */
  delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean>;
  /** Throws when the implementer cannot sign uploads (local). */
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  /** Null when the object is not there. Targets the SERVING area. */
  stat(input: { tenantId: TenantId; storageKey: string }): Promise<BlobStat | null>;
  /**
   * Same as `stat` but targets the STAGING area. Exists separately because
   * confirm-upload must learn the REAL size of the object before promoting it,
   * and at that point the object is not yet in the serving area — `stat` would
   * always answer null.
   */
  statStaging(input: { tenantId: TenantId; storageKey: string }): Promise<BlobStat | null>;
  /** First `length` bytes, for sniffing. Null when the object is not there. */
  readRange(input: {
    tenantId: TenantId;
    storageKey: string;
    length: number;
  }): Promise<Uint8Array | null>;
  /** Moves staging -> serving area. Server-side copy, bytes never pass through Node. */
  promote(input: { tenantId: TenantId; assetId: string }): Promise<StoredBlob>;
  /**
   * Removes an object from the STAGING area only — never touches the serving
   * area. A refused upload's bytes are ALWAYS in staging, never promoted, so
   * `delete` (serving-only) is the wrong call here: it would stat the serving
   * prefix, find nothing, and silently no-op, leaking the staged object
   * forever with no row left to name it. True when something was removed,
   * false when there was nothing to remove.
   */
  deleteStaging(input: { tenantId: TenantId; storageKey: string }): Promise<boolean>;
  /** Null when the implementer cannot sign; the caller falls back to streaming itself. */
  createDownloadUrl(input: {
    tenantId: TenantId;
    storageKey: string;
    expiresInSeconds: number;
  }): Promise<string | null>;
}
