import { Client } from "minio";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  BlobContent,
  BlobStat,
  CreateUploadUrlInput,
  GetBlobInput,
  MediaBlobStore,
  PresignedUpload,
  PutBlobInput,
  StoredBlob,
} from "@/core/ports/media-blob-store";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * MinIO — the production implementer of `MediaBlobStore` (E9, Task 3-4).
 *
 * TWO clients, not one: a presigned URL is signed WITH the hostname baked into
 * the signature. A URL handed to the browser must be signed with the PUBLIC
 * host, while server-side calls (stat/copy/remove/get) go through the INTERNAL
 * host inside the Docker network. Signing with the internal host produces URLs
 * that work in tests on localhost and fail in production behind the tunnel — a
 * silent failure, so the two clients stay separate on purpose.
 *
 * TWO key prefixes, one opaque `storageKey`:
 *   staging/<tenant>/<asset>  — bytes just received, NOT yet content-checked
 *   media/<tenant>/<asset>    — sniffed and approved to serve
 * `storageKey` returned to callers is `<tenant>/<asset>`, the same shape the
 * local store uses — the prefix is an adapter-internal detail so the existing
 * `storage_key` column does not need to migrate any value.
 */

/**
 * The MinIO env fields this adapter needs, named exactly like `MinioConfig`
 * (src/composition/config.ts) but declared locally rather than imported: the
 * dependency rule (docs/07) forbids adapters importing from composition.
 * `loadMinioConfig()`'s return value satisfies this shape structurally, so
 * composition wiring needs no cast and no per-field mapping.
 */
export interface MinioBlobStoreConfig {
  readonly MINIO_INTERNAL_ENDPOINT: string;
  readonly MINIO_PUBLIC_ENDPOINT: string;
  readonly MINIO_ACCESS_KEY: string;
  readonly MINIO_SECRET_KEY: string;
  readonly MINIO_BUCKET: string;
  readonly MINIO_USE_SSL: boolean;
  /**
   * Passed straight into both clients so the SDK never performs a live
   * `getBucketRegion` lookup against the endpoint before it can sign
   * anything — `Client.getBucketRegionAsync` returns this value immediately
   * when set (checked against minio@8.0.7 source). Without it, signing ran a
   * network call against the endpoint being signed for, and a public
   * endpoint the app container cannot reach (the tunnel hostname) made every
   * presign throw instead of just failing when the browser used the URL.
   */
  readonly MINIO_REGION: string;
}

export interface MinioBlobStoreOptions {
  readonly config: MinioBlobStoreConfig;
  readonly logger: Logger;
}

const SERVE_PREFIX = "media/";
const STAGING_PREFIX = "staging/";

export function makeMinioBlobStore(options: MinioBlobStoreOptions): MediaBlobStore {
  const { config, logger } = options;
  const internal = internalClientFor(config);
  const bucket = config.MINIO_BUCKET;

  return {
    async put(input: PutBlobInput): Promise<StoredBlob> {
      const key = requireStorageKey(input?.tenantId, input?.assetId);
      const bytes = input?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to store an empty blob",
          userMessage: "File rỗng — không lưu được.",
          context: { tenant_id: String(input?.tenantId), asset_id: String(input?.assetId), reason: "EMPTY_BLOB" },
        });
      }
      try {
        await internal.putObject(bucket, SERVE_PREFIX + key, Buffer.from(bytes), bytes.length, {
          "Content-Type": input.mimeType,
        });
      } catch (error) {
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_WRITE_FAILED", asset_id: input.assetId });
      }
      return { storageKey: key, sizeBytes: bytes.length };
    },

    async get(input: GetBlobInput): Promise<BlobContent | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      const maxBytes = input?.maxBytes;
      if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "maxBytes must be a positive number",
          context: { reason: "INVALID_MAX_BYTES" },
        });
      }

      const info = await this.stat({ tenantId: input.tenantId, storageKey: input.storageKey });
      if (!info) return null;
      // Checked before pulling bytes — the whole point of the cap is to never
      // buffer an oversized object into memory in the first place.
      if (info.sizeBytes > maxBytes) {
        throw new AppError("INVALID_INPUT", {
          message: "Stored blob exceeds the caller's byte cap",
          userMessage: "File đã lưu lớn hơn mức phục vụ được — cần tải lại file nhẹ hơn.",
          context: { size_bytes: info.sizeBytes, max_bytes: maxBytes, reason: "BLOB_TOO_LARGE" },
        });
      }

      try {
        const stream = await internal.getObject(bucket, SERVE_PREFIX + key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return { bytes: new Uint8Array(Buffer.concat(chunks)), mimeType: info.mimeType };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_READ_FAILED" });
      }
    },

    async delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return false;
      const existed = (await this.stat({ tenantId: input.tenantId, storageKey: input.storageKey })) !== null;
      if (!existed) return false;
      try {
        await internal.removeObject(bucket, SERVE_PREFIX + key);
        return true;
      } catch (error) {
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_DELETE_FAILED" });
      }
    },

    async deleteStaging(input: { tenantId: TenantId; storageKey: string }): Promise<boolean> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return false;
      const existed = (await this.statStaging({ tenantId: input.tenantId, storageKey: input.storageKey })) !== null;
      if (!existed) return false;
      try {
        await internal.removeObject(bucket, STAGING_PREFIX + key);
        return true;
      } catch (error) {
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAGING_DELETE_FAILED" });
      }
    },

    async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
      const key = requireStorageKey(input?.tenantId, input?.assetId);
      const maxBytes = input?.maxBytes;
      const expiresIn = input?.expiresInSeconds;
      if (typeof maxBytes !== "number" || maxBytes <= 0 || typeof expiresIn !== "number" || expiresIn <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "createUploadUrl needs a positive maxBytes and expiry",
          context: { reason: "INVALID_PRESIGN_INPUT", asset_id: input?.assetId },
        });
      }

      // Signed with the PUBLIC client: the signature is bound to the hostname,
      // and this URL runs on the operator's machine, not inside the Docker
      // network.
      const publicClient = publicClientFor(config);
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      const policy = publicClient.newPostPolicy();
      policy.setBucket(bucket);
      policy.setKey(STAGING_PREFIX + key);
      policy.setExpires(expiresAt);
      // This is what lets the bucket reject an oversized file entirely on its
      // own, with no Node process standing in the middle of the upload.
      policy.setContentLengthRange(1, maxBytes);
      policy.setContentType(input.declaredMimeType);

      try {
        const { postURL, formData } = await publicClient.presignedPostPolicy(policy);
        return { postUrl: postURL, formFields: formData, storageKey: key, expiresAt };
      } catch (error) {
        // Never put the policy or a key into the error context — a presigned
        // URL/policy is a bearer token.
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_PRESIGN_FAILED", asset_id: input.assetId });
      }
    },

    async stat(input: { tenantId: TenantId; storageKey: string }): Promise<BlobStat | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      try {
        const info = await internal.statObject(bucket, SERVE_PREFIX + key);
        return { sizeBytes: info.size, mimeType: info.metaData?.["content-type"] ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAT_FAILED" });
      }
    },

    async statStaging(input: { tenantId: TenantId; storageKey: string }): Promise<BlobStat | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      try {
        const info = await internal.statObject(bucket, STAGING_PREFIX + key);
        return { sizeBytes: info.size, mimeType: info.metaData?.["content-type"] ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAT_FAILED" });
      }
    },

    async readRange(input: {
      tenantId: TenantId;
      storageKey: string;
      length: number;
    }): Promise<Uint8Array | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      const length = input?.length;
      if (typeof length !== "number" || !Number.isInteger(length) || length <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "readRange length must be a positive integer",
          context: { reason: "INVALID_RANGE_LENGTH" },
        });
      }
      try {
        // Targets STAGING on purpose: readRange exists only to sniff bytes
        // before they are promoted into the serving area.
        const stream = await internal.getPartialObject(bucket, STAGING_PREFIX + key, 0, length);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return new Uint8Array(Buffer.concat(chunks));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_RANGE_READ_FAILED" });
      }
    },

    async promote(input: { tenantId: TenantId; assetId: string }): Promise<StoredBlob> {
      const key = requireStorageKey(input?.tenantId, input?.assetId);
      let sizeBytes: number;
      try {
        const staged = await internal.statObject(bucket, STAGING_PREFIX + key);
        sizeBytes = staged.size;
      } catch (error) {
        if (isNotFound(error)) {
          throw new AppError("INVALID_INPUT", {
            message: "Nothing to promote for this asset",
            userMessage: "Không tìm thấy file vừa tải lên.",
            context: { tenant_id: String(input.tenantId), asset_id: String(input.assetId), reason: "UPLOAD_OBJECT_MISSING" },
          });
        }
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAT_FAILED" });
      }

      try {
        // Server-side copy: bytes move inside MinIO, never through this process.
        await internal.copyObject(bucket, SERVE_PREFIX + key, `/${bucket}/${STAGING_PREFIX}${key}`);
      } catch (error) {
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_PROMOTE_FAILED", asset_id: input.assetId });
      }

      try {
        await internal.removeObject(bucket, STAGING_PREFIX + key);
      } catch (error) {
        // The serving copy already exists — this does not fail the post.
        // KNOWN LEAK, not swept: `confirm-upload.ts` deletes the ticket row
        // the moment promote succeeds, and `cleanup-uploads.ts` only ever
        // walks ticket rows — a leftover staging object with no row is
        // invisible to it, exactly the class of leak this epic exists to
        // close. Nothing currently finds or removes this object again; the
        // tenant_id + storage key below are the only way an operator can, by
        // hand, until a row-less staging sweep exists.
        logger.warn("Promoted the object but could not remove its staging copy — orphaned staging object, no sweep covers it", {
          ...AppError.from(error, "INTERNAL", { reason: "STAGING_CLEANUP_FAILED" }).toLogObject(),
          tenant_id: String(input.tenantId),
          asset_id: input.assetId,
          storage_key: key,
          staging_object: STAGING_PREFIX + key,
        });
      }

      return { storageKey: key, sizeBytes };
    },

    async createDownloadUrl(input: {
      tenantId: TenantId;
      storageKey: string;
      expiresInSeconds: number;
    }): Promise<string | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      const expiresIn = input?.expiresInSeconds;
      if (typeof expiresIn !== "number" || expiresIn <= 0) return null;
      try {
        const publicClient = publicClientFor(config);
        return await publicClient.presignedGetObject(bucket, SERVE_PREFIX + key, expiresIn);
      } catch (error) {
        // Does not throw: the caller's documented fallback is to stream the
        // bytes itself.
        logger.warn("Could not sign a download URL", {
          ...AppError.from(error, "INTERNAL", { reason: "BLOB_PRESIGN_FAILED" }).toLogObject(),
          tenant_id: String(input.tenantId),
          storage_key: key,
        });
        return null;
      }
    },
  };
}

// --- helpers -----------------------------------------------------------------

/**
 * `MINIO_INTERNAL_ENDPOINT` is a bare `host[:port]` (no scheme) — the Docker
 * network has no notion of http vs https, so TLS for this client comes from
 * `MINIO_USE_SSL` alone.
 */
function internalClientFor(config: MinioBlobStoreConfig): Client {
  const [host, port] = config.MINIO_INTERNAL_ENDPOINT.replace(/^https?:\/\//, "").split(":");
  return new Client({
    endPoint: host,
    port: port ? Number(port) : config.MINIO_USE_SSL ? 443 : 80,
    useSSL: config.MINIO_USE_SSL,
    region: config.MINIO_REGION,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });
}

/**
 * `MINIO_PUBLIC_ENDPOINT` is a full `http(s)://host[:port]` URL — config
 * validation already forces the scheme, so TLS for THIS client comes from
 * parsing that URL, never from `MINIO_USE_SSL`. That flag only describes the
 * internal hop; in production it is false (plain HTTP inside the Docker
 * network) while the public endpoint is `https://` behind the tunnel. Sharing
 * one flag between both clients previously built the public client with
 * `useSSL: false` and port 80, so every presigned URL came back as
 * `http://…` — a browser blocks that as mixed content on an https page.
 */
function publicClientFor(config: MinioBlobStoreConfig): Client {
  const url = new URL(config.MINIO_PUBLIC_ENDPOINT);
  const useSSL = url.protocol === "https:";
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : useSSL ? 443 : 80,
    useSSL,
    region: config.MINIO_REGION,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });
}

/** `<tenant>/<asset>`; throws when either segment is missing or unsafe (path escape). */
function requireStorageKey(tenantId: unknown, assetId: unknown): string {
  const tenant = safeSegment(tenantId);
  const asset = safeSegment(assetId);
  if (!tenant || !asset) {
    throw new AppError("INVALID_INPUT", {
      message: "A blob key needs a safe tenant id and asset id",
      context: { reason: "UNSAFE_BLOB_KEY" },
    });
  }
  return `${tenant}/${asset}`;
}

/** Null (never throws) when the key does not belong to this tenant — a wrong-tenant key reads as "not found". */
function safeStorageKey(tenantId: unknown, storageKey: unknown): string | null {
  const tenant = safeSegment(tenantId);
  if (!tenant || typeof storageKey !== "string") return null;
  const [keyTenant, asset, ...rest] = storageKey.split("/");
  if (rest.length > 0) return null;
  if (keyTenant !== tenant) return null;
  return safeSegment(asset) ? `${tenant}/${asset}` : null;
}

function safeSegment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "." || trimmed === "..") return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "NoSuchKey" || code === "NotFound";
}
