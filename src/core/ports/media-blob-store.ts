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

export interface MediaBlobStore {
  put(input: PutBlobInput): Promise<StoredBlob>;
  /** Null when the blob is not there (deleted, never written, wrong tenant). */
  get(input: GetBlobInput): Promise<BlobContent | null>;
  /** True when a blob was removed, false when there was nothing to remove. */
  delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean>;
}
