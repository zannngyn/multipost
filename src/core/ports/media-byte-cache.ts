/**
 * Read-through byte cache for media that lives in an EXTERNAL source (Drive).
 *
 * Why it exists — measured, not theoretical: Graph API fetches every photo URL
 * itself and gives up around 30s (code 324). Raw Drive downloads of one real
 * post's 10 files took 192.9s in total, one of them 99.9s alone, so 6 of 10
 * photos failed. An album needs all of them in the same call, so "Drive serves
 * Meta in real time" is not a workable design. The cache turns the second and
 * every later fetch of the same asset into a local read.
 *
 * NOT `media_asset.storage_key`. That column belongs to E9 mode B and is
 * documented as "null unless origin = upload" (core/domain/product.ts); the
 * upload cleanup sweep also selects on `origin = 'upload'`, so cache rows parked
 * there would never be swept. A cache is not a source of truth and must not sit
 * in a business row — it gets its own store, its own TTL and its own sweep.
 *
 * Contract for every implementer:
 * - Every method is tenant-scoped. An implementation MUST NOT let one tenant's
 *   entry resolve under another, and MUST reject ids that try to escape their
 *   tenant's area (path traversal). An id that is not safe is a MISS, never a
 *   read somewhere else.
 * - `get` returns null for miss — unknown id, expired entry, entry larger than
 *   `maxBytes`. Only a BROKEN store (unreadable disk) may throw, and even then
 *   the caller is expected to degrade to the origin rather than fail: serving
 *   the picture matters more than serving it fast.
 * - Deliberately unlike `MediaBlobStore.get`, an oversized entry is a miss here
 *   instead of an error. There the blob IS the only copy, so refusing loudly is
 *   the honest answer; here the origin still has the bytes and the caller's own
 *   size check is what must reject the asset.
 * - `put` overwrites any previous entry for the same (tenantId, assetId) and is
 *   the only writer of a cache entry. It may throw (full disk, unsafe id); the
 *   caller must treat a failed write as "not cached", not as a failed request.
 * - `evictOlderThan` is the ONLY way entries leave the store apart from being
 *   overwritten. It never throws for a single unremovable entry — it counts it
 *   and moves on, so one locked file cannot stop a sweep.
 */

export interface CachedMediaBytes {
  readonly bytes: Uint8Array;
  /**
   * MIME type recorded at write time, null when the origin gave none. Kept with
   * the bytes on purpose: a hit and a miss must serve the SAME content type, and
   * for the 606 extension-less files (docs/05 1.3) the origin's header is the
   * only place that answer exists.
   */
  readonly mimeType: string | null;
}

export interface GetCachedMediaInput {
  readonly tenantId: string;
  /** Asset identity — the Drive file id carried by post_job.media. */
  readonly assetId: string;
  /** Refuse to buffer more than this many bytes; a bigger entry is a miss. */
  readonly maxBytes: number;
}

export interface PutCachedMediaInput {
  readonly tenantId: string;
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string | null;
}

export interface EvictCachedMediaInput {
  /** Entries last written before this instant may go. */
  readonly olderThan: Date;
  /** Cap per pass, so a huge backlog drains over several ticks. */
  readonly limit?: number;
}

export interface EvictCachedMediaResult {
  readonly scanned: number;
  readonly removed: number;
  /** Entries left for the next pass because removing them failed. */
  readonly failed: number;
}

export interface MediaByteCache {
  /** Null on any kind of miss (absent, expired, too large, unsafe id). */
  get(input: GetCachedMediaInput): Promise<CachedMediaBytes | null>;
  put(input: PutCachedMediaInput): Promise<void>;
  evictOlderThan(input: EvictCachedMediaInput): Promise<EvictCachedMediaResult>;
}
