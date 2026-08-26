# MinIO + Presigned Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa byte của file operator tải lên đi thẳng browser → MinIO, không qua tiến trình Node, và thay đĩa VPS bằng object storage.

**Architecture:** Ba chặng — xin vé (`tickets`) → browser POST multipart thẳng vào MinIO bằng POST policy đã ký → xác nhận (`confirm`) nơi server `stat` + sniff 4KB đầu rồi `promote` object từ `staging/` sang `media/`. Sau bước confirm, row `media_asset` giống hệt hôm nay nên `compose-post`, `create-post-batch`, `publish-post` và worker không đổi dòng nào. Vé sống trong bảng riêng `upload_ticket`, cố ý không đụng `media_asset` để không truy vấn media nào phải thêm điều kiện lọc.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle + PostgreSQL · vitest · package `minio` (dependency MỚI, PM đã duyệt) · Docker Compose

**Spec:** `docs/superpowers/specs/2026-08-26-minio-presigned-upload-design.md`

## Global Constraints

- **Kiến trúc một chiều** (docs/07): `app/worker/ui → composition → adapters → core`. `core/` không import lib I/O. SDK `minio` **chỉ** được import trong `src/adapters/media/**`. `pnpm depcruise` cưỡng chế.
- **`ERROR_CODES` là danh sách đóng.** Không thêm mã mới vào `core/domain/errors.ts`. Nhánh lỗi mới dùng `INVALID_INPUT` hoặc `INTERNAL` với `reason` trong `context` — đúng như `upload-media.ts` đang làm.
- **Edge case trước, happy path sau.** Mỗi hàm: guard clause + early return, test edge case viết trước.
- **Cấm nuốt lỗi.** Mọi `catch` phải log có context + rethrow, hoặc chuyển trạng thái kèm lý do.
- **Log tiếng Anh, `userMessage` tiếng Việt.** Mỗi log kèm `tenant_id`, `asset_id`, `product_code`, `reason`.
- **Không log URL presigned, không log access key, không đưa chúng vào `AppError.context`.**
- Cap: `MAX_UPLOAD_BYTES = 25MB`, `MAX_UPLOADS_PER_POST = 10` (cả hai đã có trong `core/domain/uploaded-media.ts`, giữ nguyên).
- TTL vé upload **30 phút**; TTL presigned download **5 phút**.
- Hostname công khai: `https://media.vannt.asia`.
- Test tích hợp gác bằng `describe.skipIf(!process.env.TEST_MINIO_ENDPOINT)` — cùng khuôn với `describe.skipIf(!url)` ở `src/adapters/db/credential-repo.write.integration.test.ts:53`.
- Lệnh cổng cuối mỗi task: `pnpm verify` (typecheck · lint · depcruise · theme · test · build).

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/composition/config.ts` | thêm `MinioConfigSchema` + `loadMinioConfig` |
| `src/core/ports/media-blob-store.ts` | mở rộng port: `createUploadUrl`, `stat`, `readRange`, `promote`, `createDownloadUrl` |
| `src/adapters/media/local-blob-store.ts` | implement phần mới bằng FS; `createUploadUrl` ném, `createDownloadUrl` trả null |
| `src/adapters/media/minio-blob-store.ts` | **mới** — toàn bộ port trên MinIO |
| `src/adapters/db/schema/upload-ticket.ts` | **mới** — bảng `upload_ticket` |
| `src/core/ports/upload-ticket-repo.ts` | **mới** — port vé |
| `src/adapters/db/upload-ticket-repo.drizzle.ts` | **mới** — adapter vé |
| `src/core/usecases/issue-upload-tickets.ts` | **mới** — cấp vé |
| `src/core/usecases/confirm-upload.ts` | **mới** — duyệt + promote + register |
| `src/app/api/posts/uploads/tickets/route.ts` | **mới** — route mỏng |
| `src/app/api/posts/uploads/confirm/route.ts` | **mới** — route mỏng |
| `src/core/usecases/cleanup-uploads.ts` | thêm dọn vé quá hạn + object staging mồ côi |
| `src/app/api/media/[driveFileId]/route.ts` | trả 302 khi store ký được URL đọc |
| `src/ui/services/upload.api.ts` | **mới** — gọi 3 chặng |
| `src/ui/hooks/useDirectUpload.ts` | **mới** — hàng đợi POST, tiến độ, huỷ |
| `src/ui/components/compose/UploadPanel.tsx` | chuyển sang đường mới |
| `scripts/migrate-uploads-to-minio.ts` | **mới** — di trú một lần |
| `docker-compose.yml` / `.prod.yml` / `.env.example` | service `minio`, volume, env |

---

## Task 1: Config MinIO + dependency

**Files:**
- Modify: `package.json`
- Modify: `src/composition/config.ts:323-334` (ngay sau `UploadConfigSchema`)
- Test: `src/composition/config.minio.test.ts`

**Interfaces:**
- Produces: `MinioConfigSchema`, `loadMinioConfig(env?): MinioConfig` với các khoá `MINIO_INTERNAL_ENDPOINT`, `MINIO_PUBLIC_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_USE_SSL`.

- [ ] **Step 1: Cài dependency và kiểm nó nạp được dưới Next 16**

```bash
pnpm add minio
node -e "const {Client}=require('minio');console.log(typeof Client)"
```

Kỳ vọng in `function`. Nếu lỗi ESM/CJS thì **dừng lại và báo PM** — đó là rủi ro #4 của spec, không tự đổi sang thư viện khác.

- [ ] **Step 2: Viết test thất bại**

```ts
// src/composition/config.minio.test.ts
import { describe, expect, it } from "vitest";
import { loadMinioConfig } from "@/composition/config";

const base = {
  MINIO_INTERNAL_ENDPOINT: "minio:9000",
  MINIO_PUBLIC_ENDPOINT: "https://media.vannt.asia",
  MINIO_ACCESS_KEY: "key",
  MINIO_SECRET_KEY: "secret",
};

describe("loadMinioConfig", () => {
  it("mặc định bucket và useSSL", () => {
    const cfg = loadMinioConfig(base);
    expect(cfg.MINIO_BUCKET).toBe("mysp-media");
    expect(cfg.MINIO_USE_SSL).toBe(true);
  });

  it("từ chối khi thiếu secret", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_SECRET_KEY: "" })).toThrow();
  });

  it("từ chối public endpoint không phải URL", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_PUBLIC_ENDPOINT: "minio:9000" })).toThrow();
  });
});
```

- [ ] **Step 3: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/composition/config.minio.test.ts`
Expected: FAIL — `loadMinioConfig is not a function`.

- [ ] **Step 4: Thêm schema**

```ts
// src/composition/config.ts — ngay sau UploadConfigSchema
/**
 * MinIO. Hai endpoint chứ không phải một: URL presigned được KÝ kèm hostname,
 * nên URL đưa ra browser phải ký bằng host công khai, còn stat/copy/delete
 * phía server đi bằng host nội bộ trong mạng Docker. Ký nhầm host là lỗi im
 * lặng — chỉ lộ khi chạy thật qua tunnel.
 */
export const MinioConfigSchema = z.object({
  MINIO_INTERNAL_ENDPOINT: z.string().trim().min(1),
  MINIO_PUBLIC_ENDPOINT: z.string().trim().url(),
  MINIO_ACCESS_KEY: z.string().trim().min(1),
  MINIO_SECRET_KEY: z.string().trim().min(1),
  MINIO_BUCKET: z.string().trim().min(1).default("mysp-media"),
  MINIO_USE_SSL: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((value) => (typeof value === "boolean" ? value : value.trim().toLowerCase() !== "false")),
});

export type MinioConfig = z.infer<typeof MinioConfigSchema>;

export function loadMinioConfig(env: EnvRecord = process.env): MinioConfig {
  return parseEnv(MinioConfigSchema, env, "minio");
}
```

- [ ] **Step 5: Chạy lại test**

Run: `pnpm vitest run src/composition/config.minio.test.ts`
Expected: PASS (3 test).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/composition/config.ts src/composition/config.minio.test.ts
git commit -m "feat(media): add MinIO config group and the minio dependency"
```

---

## Task 2: Mở rộng port MediaBlobStore

**Files:**
- Modify: `src/core/ports/media-blob-store.ts:53-60`
- Modify: `src/adapters/media/local-blob-store.ts`
- Test: `src/adapters/media/local-blob-store.extended.test.ts`

**Interfaces:**
- Produces: `CreateUploadUrlInput`, `PresignedUpload`, `BlobStat`, và 5 method mới trên `MediaBlobStore`. Task 3, 4, 6, 7, 8, 9 đều dựa vào chữ ký ở đây.

- [ ] **Step 1: Viết test thất bại cho local store**

```ts
// src/adapters/media/local-blob-store.extended.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeLocalBlobStore } from "@/adapters/media/local-blob-store";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

const TENANT = "11111111-1111-4111-8111-111111111111" as never;
let root = "";
let store: MediaBlobStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blob-"));
  store = makeLocalBlobStore({ root });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("local blob store — phần mở rộng", () => {
  it("stat trả kích thước thật, null khi không có object", async () => {
    await store.put({ tenantId: TENANT, assetId: "a1", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", kind: "image" });
    expect(await store.stat({ tenantId: TENANT, storageKey: `${TENANT}/a1` })).toMatchObject({ sizeBytes: 3 });
    expect(await store.stat({ tenantId: TENANT, storageKey: `${TENANT}/nope` })).toBeNull();
  });

  it("readRange chỉ đọc n byte đầu", async () => {
    await store.put({ tenantId: TENANT, assetId: "a2", bytes: new Uint8Array([9, 8, 7, 6, 5]), mimeType: "image/png", kind: "image" });
    const head = await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/a2`, length: 2 });
    expect(head).toEqual(new Uint8Array([9, 8]));
  });

  it("createDownloadUrl trả null — local không ký được", async () => {
    expect(await store.createDownloadUrl({ tenantId: TENANT, storageKey: `${TENANT}/a1`, expiresInSeconds: 300 })).toBeNull();
  });

  it("createUploadUrl ném, có reason rõ ràng", async () => {
    await expect(
      store.createUploadUrl({ tenantId: TENANT, assetId: "a3", declaredMimeType: "image/png", maxBytes: 10, expiresInSeconds: 60 }),
    ).rejects.toMatchObject({ context: { reason: "PRESIGN_UNSUPPORTED" } });
  });
});
```

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/adapters/media/local-blob-store.extended.test.ts`
Expected: FAIL — `store.stat is not a function`.

- [ ] **Step 3: Mở rộng port**

```ts
// src/core/ports/media-blob-store.ts — thay khối `export interface MediaBlobStore`
export interface CreateUploadUrlInput {
  readonly tenantId: TenantId;
  readonly assetId: string;
  /** Mime client khai báo; policy ràng buộc đúng giá trị này. */
  readonly declaredMimeType: string;
  /** Trần byte gắn vào chính policy, để storage tự từ chối file quá lớn. */
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

/**
 * POST policy, KHÔNG phải presigned PUT: chỉ POST policy mang được
 * `content-length-range`, tức chỉ nó khiến bucket tự chặn 25MB mà không cần
 * Node đứng giữa.
 */
export interface PresignedUpload {
  readonly postUrl: string;
  /** Đính vào FormData TRƯỚC field `file`. */
  readonly formFields: Readonly<Record<string, string>>;
  /** Key của object ở vùng staging. */
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export interface BlobStat {
  readonly sizeBytes: number;
  readonly mimeType: string | null;
}

export interface MediaBlobStore {
  put(input: PutBlobInput): Promise<StoredBlob>;
  get(input: GetBlobInput): Promise<BlobContent | null>;
  delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean>;
  /** Ném khi implementer không ký được (local). */
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  /** Null khi object không có. */
  stat(input: { tenantId: TenantId; storageKey: string }): Promise<BlobStat | null>;
  /** n byte đầu để sniff. Null khi object không có. */
  readRange(input: { tenantId: TenantId; storageKey: string; length: number }): Promise<Uint8Array | null>;
  /** Chuyển staging → vùng phục vụ. Copy phía server, byte không qua Node. */
  promote(input: { tenantId: TenantId; assetId: string }): Promise<StoredBlob>;
  /** Null = implementer không ký được; caller tự stream. */
  createDownloadUrl(input: {
    tenantId: TenantId;
    storageKey: string;
    expiresInSeconds: number;
  }): Promise<string | null>;
}
```

- [ ] **Step 4: Implement trên local store**

Thêm vào object trả về của `makeLocalBlobStore`, sau `delete`. Import thêm `open` từ `node:fs/promises`.

```ts
    async stat(input): Promise<BlobStat | null> {
      const path = resolveKey(root, input?.tenantId, input?.storageKey);
      if (!path) return null;
      try {
        const info = await stat(/* turbopackIgnore: true */ path);
        return info.isFile() ? { sizeBytes: info.size, mimeType: null } : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAT_FAILED" });
      }
    },

    async readRange(input): Promise<Uint8Array | null> {
      const path = resolveKey(root, input?.tenantId, input?.storageKey);
      if (!path) return null;
      const length = input?.length;
      if (typeof length !== "number" || !Number.isInteger(length) || length <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "readRange length must be a positive integer",
          context: { reason: "INVALID_RANGE_LENGTH" },
        });
      }
      let handle;
      try {
        handle = await open(/* turbopackIgnore: true */ path, "r");
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_OPEN_FAILED" });
      }
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },

    async promote(input): Promise<StoredBlob> {
      // Local không có vùng staging riêng: put() đã ghi thẳng vào vùng phục vụ.
      const tenantId = requireSafeSegment(input?.tenantId, "tenant_id");
      const assetId = requireSafeSegment(input?.assetId, "asset_id");
      const storageKey = `${tenantId}/${assetId}`;
      const info = await this.stat({ tenantId: input.tenantId, storageKey });
      if (!info) {
        throw new AppError("INVALID_INPUT", {
          message: "Nothing to promote for this asset",
          userMessage: "Không tìm thấy file vừa tải lên.",
          context: { tenant_id: tenantId, asset_id: assetId, reason: "UPLOAD_OBJECT_MISSING" },
        });
      }
      return { storageKey, sizeBytes: info.sizeBytes };
    },

    async createDownloadUrl(): Promise<string | null> {
      // Không ký được: người gọi tự stream qua Node, đúng hành vi hôm nay.
      return null;
    },

    async createUploadUrl(input): Promise<PresignedUpload> {
      throw new AppError("INTERNAL", {
        message: "The local blob store cannot sign an upload policy",
        userMessage: "Kho lưu trữ hiện tại không hỗ trợ tải thẳng — liên hệ quản trị.",
        context: { tenant_id: String(input?.tenantId ?? ""), reason: "PRESIGN_UNSUPPORTED" },
      });
    },
```

- [ ] **Step 5: Chạy test**

Run: `pnpm vitest run src/adapters/media/local-blob-store.extended.test.ts`
Expected: PASS (4 test).

- [ ] **Step 6: Chạy toàn bộ để chắc không gãy chỗ khác**

Run: `pnpm typecheck && pnpm vitest run`
Expected: exit 0. Nếu fixture nào implement `MediaBlobStore` thủ công thì typecheck sẽ đỏ — bổ sung 5 method vào đúng fixture đó, đừng nới lỏng kiểu.

- [ ] **Step 7: Commit**

```bash
git add src/core/ports/media-blob-store.ts src/adapters/media/
git commit -m "feat(media): extend MediaBlobStore with presign, stat, readRange and promote"
```

---

## Task 3: Adapter MinIO — put / get / delete

**Files:**
- Create: `src/adapters/media/minio-blob-store.ts`
- Test: `src/adapters/media/minio-blob-store.integration.test.ts`

**Interfaces:**
- Consumes: `MediaBlobStore` (Task 2), `MinioConfig` (Task 1).
- Produces: `makeMinioBlobStore(options: MinioBlobStoreOptions): MediaBlobStore`, với `MinioBlobStoreOptions = { config: MinioConfig; logger: Logger }`. Key: `media/<tenantId>/<assetId>` (phục vụ) và `staging/<tenantId>/<assetId>` (chưa duyệt). `storageKey` trả về là **phần sau `media/`**, tức `<tenantId>/<assetId>` — giữ nguyên định dạng của local store để không phải di trú giá trị cột `storage_key`.

- [ ] **Step 1: Viết test tích hợp thất bại**

```ts
// src/adapters/media/minio-blob-store.integration.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { makeMinioBlobStore } from "@/adapters/media/minio-blob-store";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

/**
 * Chạy khi có MinIO thật:
 *   docker compose up -d minio
 *   TEST_MINIO_ENDPOINT=localhost:9000 pnpm vitest run src/adapters/media/minio-blob-store.integration.test.ts
 */
const endpoint = process.env.TEST_MINIO_ENDPOINT;
const TENANT = randomUUID() as never;
const noopLogger = { info(){}, warn(){}, error(){}, debug(){}, child(){ return noopLogger; } } as never;

let store: MediaBlobStore;
beforeAll(() => {
  if (!endpoint) return;
  store = makeMinioBlobStore({
    config: {
      MINIO_INTERNAL_ENDPOINT: endpoint,
      MINIO_PUBLIC_ENDPOINT: "http://localhost:9000",
      MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
      MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
      MINIO_BUCKET: "mysp-media-test",
      MINIO_USE_SSL: false,
    },
    logger: noopLogger,
  });
});

describe.skipIf(!endpoint)("MinioBlobStore — put/get/delete", () => {
  it("ghi rồi đọc lại đúng byte", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const stored = await store.put({ tenantId: TENANT, assetId: "p1", bytes, mimeType: "image/png", kind: "image" });
    expect(stored.storageKey).toBe(`${TENANT}/p1`);
    expect(stored.sizeBytes).toBe(4);

    const got = await store.get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 1024 });
    expect(got?.bytes).toEqual(bytes);
  });

  it("get trả null khi key không có", async () => {
    expect(await store.get({ tenantId: TENANT, storageKey: `${TENANT}/khong-co`, maxBytes: 1024 })).toBeNull();
  });

  it("get từ chối khi object lớn hơn maxBytes, KHÔNG kéo byte về", async () => {
    await store.put({ tenantId: TENANT, assetId: "p2", bytes: new Uint8Array(1024), mimeType: "image/png", kind: "image" });
    await expect(store.get({ tenantId: TENANT, storageKey: `${TENANT}/p2`, maxBytes: 10 }))
      .rejects.toMatchObject({ context: { reason: "BLOB_TOO_LARGE" } });
  });

  it("không cho key của tenant khác lọt qua", async () => {
    const other = randomUUID();
    expect(await store.get({ tenantId: TENANT, storageKey: `${other}/p1`, maxBytes: 1024 })).toBeNull();
  });

  it("delete trả true rồi false", async () => {
    expect(await store.delete({ tenantId: TENANT, storageKey: `${TENANT}/p1` })).toBe(true);
    expect(await store.delete({ tenantId: TENANT, storageKey: `${TENANT}/p1` })).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/adapters/media/minio-blob-store.integration.test.ts`
Expected: SKIP hết (chưa có `TEST_MINIO_ENDPOINT`) — điều đó đúng, nhưng typecheck phải đỏ vì chưa có module. Kiểm bằng `pnpm typecheck`, kỳ vọng FAIL "Cannot find module '@/adapters/media/minio-blob-store'".

- [ ] **Step 3: Viết adapter, phần put/get/delete**

```ts
// src/adapters/media/minio-blob-store.ts
import { Client } from "minio";

import type { MinioConfig } from "@/composition/config";
import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  BlobContent,
  BlobStat,
  GetBlobInput,
  MediaBlobStore,
  PutBlobInput,
  StoredBlob,
} from "@/core/ports/media-blob-store";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * MinIO là implementer duy nhất của MediaBlobStore ở production.
 *
 * HAI client, không phải một: URL ký sẵn mang theo hostname trong chữ ký. URL
 * đưa ra browser phải ký bằng host CÔNG KHAI, còn stat/copy/delete phía server
 * đi bằng host NỘI BỘ trong mạng Docker. Ký nhầm host là lỗi im lặng — nó chỉ
 * lộ khi chạy thật qua tunnel, nên hai client tách bạch ngay từ đầu.
 *
 * Hai vùng khoá:
 *   staging/<tenant>/<asset>  — byte vừa nhận, CHƯA duyệt kiểu
 *   media/<tenant>/<asset>    — đã sniff xong, được phép phục vụ
 * `storageKey` trả ra ngoài là `<tenant>/<asset>`, y hệt local store, nên cột
 * `storage_key` đang có không phải di trú giá trị.
 */

export interface MinioBlobStoreOptions {
  readonly config: MinioConfig;
  readonly logger: Logger;
}

const SERVE_PREFIX = "media/";
const STAGING_PREFIX = "staging/";

export function makeMinioBlobStore(options: MinioBlobStoreOptions): MediaBlobStore {
  const { config, logger } = options;
  const internal = clientFor(config.MINIO_INTERNAL_ENDPOINT, config);
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
      // Kiểm TRƯỚC khi kéo byte — mục đích của cap là không nạp vào bộ nhớ.
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

    async delete(input): Promise<boolean> {
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

    // Task 4 điền nốt: createUploadUrl, stat, readRange, promote, createDownloadUrl
  } as MediaBlobStore;
}

// --- helpers -----------------------------------------------------------------

function clientFor(endpoint: string, config: MinioConfig): Client {
  const [host, port] = endpoint.replace(/^https?:\/\//, "").split(":");
  return new Client({
    endPoint: host,
    port: port ? Number(port) : config.MINIO_USE_SSL ? 443 : 80,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });
}

/** `<tenant>/<asset>`; ném khi thiếu hoặc chứa ký tự thoát thư mục. */
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

/** Null (không ném) khi key không thuộc tenant — đọc nhầm tenant là "không có". */
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
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "NoSuchKey" || code === "NotFound";
}
```

- [ ] **Step 4: Dựng MinIO và chạy test tích hợp**

```bash
docker run -d --name minio-test -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
docker run --rm --network host --entrypoint sh minio/mc -c "mc alias set t http://localhost:9000 minioadmin minioadmin && mc mb -p t/mysp-media-test"
TEST_MINIO_ENDPOINT=localhost:9000 pnpm vitest run src/adapters/media/minio-blob-store.integration.test.ts
```

Expected: PASS (5 test). Dọn: `docker rm -f minio-test`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/media/minio-blob-store.ts src/adapters/media/minio-blob-store.integration.test.ts
git commit -m "feat(media): add the MinIO blob store (put/get/delete)"
```

---

## Task 4: Adapter MinIO — POST policy, stat, readRange, promote, download URL

**Files:**
- Modify: `src/adapters/media/minio-blob-store.ts`
- Modify: `src/adapters/media/minio-blob-store.integration.test.ts`

**Interfaces:**
- Produces: 5 method còn lại của port. Task 6 dùng `createUploadUrl`; Task 7 dùng `stat`/`readRange`/`promote`; Task 9 dùng `createDownloadUrl`.

- [ ] **Step 1: Thêm test thất bại**

```ts
// nối vào cuối src/adapters/media/minio-blob-store.integration.test.ts
describe.skipIf(!endpoint)("MinioBlobStore — presign và promote", () => {
  it("POST policy nhận file đúng cỡ và TỪ CHỐI file quá cỡ", async () => {
    const signed = await store.createUploadUrl({
      tenantId: TENANT, assetId: "u1", declaredMimeType: "image/png", maxBytes: 8, expiresInSeconds: 60,
    });

    const ok = new FormData();
    for (const [k, v] of Object.entries(signed.formFields)) ok.append(k, v);
    ok.append("file", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    expect((await fetch(signed.postUrl, { method: "POST", body: ok })).ok).toBe(true);

    const tooBig = new FormData();
    for (const [k, v] of Object.entries(signed.formFields)) tooBig.append(k, v);
    tooBig.append("file", new Blob([new Uint8Array(64)], { type: "image/png" }));
    expect((await fetch(signed.postUrl, { method: "POST", body: tooBig })).ok).toBe(false);
  });

  it("readRange đọc 4 byte đầu của object staging", async () => {
    const head = await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/u1`, length: 4 });
    expect(head).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("promote chuyển staging sang vùng phục vụ và xoá bản staging", async () => {
    const promoted = await store.promote({ tenantId: TENANT, assetId: "u1" });
    expect(promoted.storageKey).toBe(`${TENANT}/u1`);
    expect(promoted.sizeBytes).toBe(4);
    expect(await store.get({ tenantId: TENANT, storageKey: `${TENANT}/u1`, maxBytes: 1024 })).not.toBeNull();
    expect(await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/u1`, length: 4 })).toBeNull();
  });

  it("promote ném UPLOAD_OBJECT_MISSING khi không có bản staging", async () => {
    await expect(store.promote({ tenantId: TENANT, assetId: "khongco" }))
      .rejects.toMatchObject({ context: { reason: "UPLOAD_OBJECT_MISSING" } });
  });

  it("createDownloadUrl ký được URL tải về dùng thật", async () => {
    const url = await store.createDownloadUrl({ tenantId: TENANT, storageKey: `${TENANT}/u1`, expiresInSeconds: 60 });
    expect(url).toBeTruthy();
    expect((await fetch(url as string)).ok).toBe(true);
  });
});
```

Lưu ý: `readRange` trong test này đọc vùng **staging** trước khi promote, và trả `null` sau khi promote — nên `readRange` phải nhắm `staging/`, còn `stat`/`get`/`delete` nhắm `media/`.

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `TEST_MINIO_ENDPOINT=localhost:9000 pnpm vitest run src/adapters/media/minio-blob-store.integration.test.ts`
Expected: FAIL — `store.createUploadUrl is not a function`.

- [ ] **Step 3: Điền 5 method**

Thay dòng `// Task 4 điền nốt: ...` bằng:

```ts
    async createUploadUrl(input): Promise<PresignedUpload> {
      const key = requireStorageKey(input?.tenantId, input?.assetId);
      const maxBytes = input?.maxBytes;
      const expiresIn = input?.expiresInSeconds;
      if (typeof maxBytes !== "number" || maxBytes <= 0 || typeof expiresIn !== "number" || expiresIn <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "createUploadUrl needs a positive maxBytes and expiry",
          context: { reason: "INVALID_PRESIGN_INPUT", asset_id: input?.assetId },
        });
      }

      // Ký bằng client CÔNG KHAI: chữ ký gắn với hostname, và URL này chạy trên
      // máy của operator, không phải trong mạng Docker.
      const publicClient = clientFor(config.MINIO_PUBLIC_ENDPOINT, config);
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      const policy = publicClient.newPostPolicy();
      policy.setBucket(bucket);
      policy.setKey(STAGING_PREFIX + key);
      policy.setExpires(expiresAt);
      // Chính dòng này khiến bucket tự chặn file quá cỡ mà không cần Node.
      policy.setContentLengthRange(1, maxBytes);
      policy.setContentType(input.declaredMimeType);

      try {
        const { postURL, formData } = await publicClient.presignedPostPolicy(policy);
        return { postUrl: postURL, formFields: formData, storageKey: key, expiresAt };
      } catch (error) {
        // Không đưa policy hay khoá vào context.
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_PRESIGN_FAILED", asset_id: input.assetId });
      }
    },

    async stat(input): Promise<BlobStat | null> {
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

    async readRange(input): Promise<Uint8Array | null> {
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
        // Vùng STAGING: readRange chỉ phục vụ khâu sniff trước khi promote.
        const stream = await internal.getPartialObject(bucket, STAGING_PREFIX + key, 0, length);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return new Uint8Array(Buffer.concat(chunks));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_RANGE_READ_FAILED" });
      }
    },

    async promote(input): Promise<StoredBlob> {
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
        // Copy phía server: byte đi trong MinIO, không qua tiến trình này.
        await internal.copyObject(bucket, SERVE_PREFIX + key, `/${bucket}/${STAGING_PREFIX}${key}`);
      } catch (error) {
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_PROMOTE_FAILED", asset_id: input.assetId });
      }

      try {
        await internal.removeObject(bucket, STAGING_PREFIX + key);
      } catch (error) {
        // Bản phục vụ đã có — không hỏng bài đăng. Sweep giờ sẽ dọn bản thừa.
        logger.warn("Promoted the object but could not remove its staging copy", {
          ...AppError.from(error, "INTERNAL", { reason: "STAGING_CLEANUP_FAILED" }).toLogObject(),
          asset_id: input.assetId,
        });
      }

      return { storageKey: key, sizeBytes };
    },

    async createDownloadUrl(input): Promise<string | null> {
      const key = safeStorageKey(input?.tenantId, input?.storageKey);
      if (!key) return null;
      const expiresIn = input?.expiresInSeconds;
      if (typeof expiresIn !== "number" || expiresIn <= 0) return null;
      try {
        const publicClient = clientFor(config.MINIO_PUBLIC_ENDPOINT, config);
        return await publicClient.presignedGetObject(bucket, SERVE_PREFIX + key, expiresIn);
      } catch (error) {
        // Không ném: người gọi còn đường lui là tự stream.
        logger.warn("Could not sign a download URL", {
          ...AppError.from(error, "INTERNAL", { reason: "BLOB_PRESIGN_FAILED" }).toLogObject(),
        });
        return null;
      }
    },
```

Bỏ `as MediaBlobStore` ở cuối `return { ... }` — object giờ đã đủ method, và ép kiểu sẽ che mất lỗi thiếu.

- [ ] **Step 4: Chạy test tích hợp**

Run: `TEST_MINIO_ENDPOINT=localhost:9000 pnpm vitest run src/adapters/media/minio-blob-store.integration.test.ts`
Expected: PASS (10 test).

- [ ] **Step 5: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0. `depcruise` phải xanh — `minio` chỉ được import ở `src/adapters/media/`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/media/minio-blob-store.ts src/adapters/media/minio-blob-store.integration.test.ts
git commit -m "feat(media): sign upload policies and promote staged objects on MinIO"
```

---

## Task 5: Bảng và repo `upload_ticket`

**Files:**
- Create: `src/adapters/db/schema/upload-ticket.ts`
- Modify: `src/adapters/db/schema/index.ts` (thêm `export * from "./upload-ticket";` sau dòng `export * from "./media-asset";`)
- Create: `src/core/ports/upload-ticket-repo.ts`
- Create: `src/adapters/db/upload-ticket-repo.drizzle.ts`
- Test: `src/adapters/db/upload-ticket-repo.write.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface UploadTicket {
    tenantId: TenantId; assetId: string; storageKey: string; fileName: string;
    declaredMime: string; declaredSize: number; productCode: string; expiresAt: Date;
  }
  interface UploadTicketRepo {
    createMany(tenantId: TenantId, tickets: readonly UploadTicket[]): Promise<number>;
    findMany(tenantId: TenantId, assetIds: readonly string[]): Promise<readonly UploadTicket[]>;
    deleteMany(tenantId: TenantId, assetIds: readonly string[]): Promise<number>;
    listExpired(input: { now: Date; limit: number }): Promise<readonly UploadTicket[]>;
  }
  ```
  Task 6 dùng `createMany`; Task 7 dùng `findMany` + `deleteMany`; Task 8 dùng `listExpired` + `deleteMany`.

- [ ] **Step 1: Viết schema**

```ts
// src/adapters/db/schema/upload-ticket.ts
import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Một file đã được cấp URL ký sẵn nhưng CHƯA được duyệt kiểu.
 *
 * Bảng riêng, cố ý không phải một trạng thái của `media_asset`: nếu vé sống
 * trong `media_asset` thì mọi truy vấn media đang có (compose, danh sách sản
 * phẩm, preview) đều phải thêm điều kiện lọc, và bỏ sót MỘT chỗ là ảnh chưa
 * duyệt lọt vào bài đăng. Bảng riêng khiến rủi ro đó bằng không.
 */
export const uploadTickets = pgTable(
  "upload_ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    /** Định danh asset; thành `media_asset.drive_file_id` sau khi confirm. */
    assetId: text("asset_id").notNull(),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    declaredMime: text("declared_mime").notNull(),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    productCode: text("product_code").notNull(),
    createdBy: text("created_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    // Confirm tra theo (tenant, asset); sweep quét theo expires_at.
    index("upload_ticket_tenant_asset_idx").on(table.tenantId, table.assetId),
    index("upload_ticket_expires_idx").on(table.expiresAt),
  ],
);

export type UploadTicketRow = typeof uploadTickets.$inferSelect;
export type NewUploadTicketRow = typeof uploadTickets.$inferInsert;
```

- [ ] **Step 2: Sinh migration và kiểm file thật ra đời**

```bash
printf '\nexport * from "./upload-ticket";\n' >> /dev/null   # xem Step 3, sửa index.ts bằng tay
pnpm db:generate
ls -t drizzle/*.sql | head -1
grep -n "upload_ticket" $(ls -t drizzle/*.sql | head -1)
```

Expected: file `.sql` mới nhất có `CREATE TABLE "upload_ticket"`. Nếu không có, kiểm lại `index.ts` đã export chưa — drizzle-kit chỉ thấy bảng qua barrel.

- [ ] **Step 3: Thêm export vào barrel**

Trong `src/adapters/db/schema/index.ts`, chèn ngay sau `export * from "./media-asset";`:

```ts
export * from "./upload-ticket";
```

- [ ] **Step 4: Viết port**

```ts
// src/core/ports/upload-ticket-repo.ts
import type { TenantId } from "@/core/domain/tenant-context";

/** Một file đã được cấp URL ký sẵn, chưa qua cổng duyệt kiểu. */
export interface UploadTicket {
  readonly tenantId: TenantId;
  readonly assetId: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly productCode: string;
  readonly expiresAt: Date;
  readonly createdBy?: string | null;
}

export interface UploadTicketRepo {
  createMany(tenantId: TenantId, tickets: readonly UploadTicket[]): Promise<number>;
  /** Chỉ trả vé của ĐÚNG tenant này; vé của tenant khác coi như không có. */
  findMany(tenantId: TenantId, assetIds: readonly string[]): Promise<readonly UploadTicket[]>;
  deleteMany(tenantId: TenantId, assetIds: readonly string[]): Promise<number>;
  /** Cho sweep: vé đã quá hạn, mọi tenant. */
  listExpired(input: { now: Date; limit: number }): Promise<readonly UploadTicket[]>;
}
```

- [ ] **Step 5: Viết test tích hợp thất bại**

```ts
// src/adapters/db/upload-ticket-repo.write.integration.test.ts
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { makeDbHandle } from "./client";
import { DrizzleUploadTicketRepo } from "./upload-ticket-repo.drizzle";
import type { TenantId } from "@/core/domain/tenant-context";

const url = process.env.TEST_DATABASE_URL;
const TENANT = randomUUID() as TenantId;
const OTHER = randomUUID() as TenantId;

describe.skipIf(!url)("DrizzleUploadTicketRepo", () => {
  let repo: DrizzleUploadTicketRepo;
  beforeEach(() => { repo = new DrizzleUploadTicketRepo(makeDbHandle(url as string)); });

  const ticket = (assetId: string, tenantId = TENANT, expiresAt = new Date(Date.now() + 60_000)) => ({
    tenantId, assetId, storageKey: `${tenantId}/${assetId}`, fileName: `${assetId}.jpg`,
    declaredMime: "image/jpeg", declaredSize: 100, productCode: "MG0AD6112", expiresAt,
  });

  it("tạo rồi tìm lại được", async () => {
    await repo.createMany(TENANT, [ticket("t1"), ticket("t2")]);
    const found = await repo.findMany(TENANT, ["t1", "t2"]);
    expect(found.map((t) => t.assetId).sort()).toEqual(["t1", "t2"]);
  });

  it("KHÔNG trả vé của tenant khác", async () => {
    await repo.createMany(OTHER, [ticket("t3", OTHER)]);
    expect(await repo.findMany(TENANT, ["t3"])).toHaveLength(0);
  });

  it("deleteMany chỉ xoá trong tenant của mình", async () => {
    expect(await repo.deleteMany(TENANT, ["t3"])).toBe(0);
    expect(await repo.deleteMany(TENANT, ["t1"])).toBe(1);
  });

  it("listExpired chỉ trả vé đã quá hạn", async () => {
    await repo.createMany(TENANT, [ticket("t4", TENANT, new Date(Date.now() - 60_000))]);
    const expired = await repo.listExpired({ now: new Date(), limit: 50 });
    expect(expired.map((t) => t.assetId)).toContain("t4");
    expect(expired.map((t) => t.assetId)).not.toContain("t2");
  });

  it("findMany với danh sách rỗng trả rỗng, không đụng DB", async () => {
    expect(await repo.findMany(TENANT, [])).toEqual([]);
  });
});
```

- [ ] **Step 6: Chạy để chắc chắn nó fail**

Run: `pnpm typecheck`
Expected: FAIL — `Cannot find module './upload-ticket-repo.drizzle'`.

- [ ] **Step 7: Viết adapter**

```ts
// src/adapters/db/upload-ticket-repo.drizzle.ts
import { and, eq, inArray, lt } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import type { DbHandle } from "./client";
import { uploadTickets, type UploadTicketRow } from "./schema";

export class DrizzleUploadTicketRepo implements UploadTicketRepo {
  constructor(private readonly db: DbHandle) {}

  async createMany(tenantId: TenantId, tickets: readonly UploadTicket[]): Promise<number> {
    if (tickets.length === 0) return 0;
    try {
      const rows = tickets.map((t) => ({
        tenantId,
        assetId: t.assetId,
        storageKey: t.storageKey,
        fileName: t.fileName,
        declaredMime: t.declaredMime,
        declaredSize: t.declaredSize,
        productCode: t.productCode,
        createdBy: t.createdBy ?? null,
        expiresAt: t.expiresAt,
      }));
      await this.db.insert(uploadTickets).values(rows);
      return rows.length;
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", { tenant_id: tenantId, reason: "TICKET_INSERT_FAILED" });
    }
  }

  async findMany(tenantId: TenantId, assetIds: readonly string[]): Promise<readonly UploadTicket[]> {
    if (assetIds.length === 0) return [];
    try {
      const rows = await this.db
        .select()
        .from(uploadTickets)
        .where(and(eq(uploadTickets.tenantId, tenantId), inArray(uploadTickets.assetId, [...assetIds])));
      return rows.map(toTicket);
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", { tenant_id: tenantId, reason: "TICKET_SELECT_FAILED" });
    }
  }

  async deleteMany(tenantId: TenantId, assetIds: readonly string[]): Promise<number> {
    if (assetIds.length === 0) return 0;
    try {
      const removed = await this.db
        .delete(uploadTickets)
        .where(and(eq(uploadTickets.tenantId, tenantId), inArray(uploadTickets.assetId, [...assetIds])))
        .returning({ assetId: uploadTickets.assetId });
      return removed.length;
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", { tenant_id: tenantId, reason: "TICKET_DELETE_FAILED" });
    }
  }

  async listExpired(input: { now: Date; limit: number }): Promise<readonly UploadTicket[]> {
    try {
      const rows = await this.db
        .select()
        .from(uploadTickets)
        .where(lt(uploadTickets.expiresAt, input.now))
        .limit(input.limit);
      return rows.map(toTicket);
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", { reason: "TICKET_EXPIRED_SELECT_FAILED" });
    }
  }
}

function toTicket(row: UploadTicketRow): UploadTicket {
  return {
    tenantId: row.tenantId as TenantId,
    assetId: row.assetId,
    storageKey: row.storageKey,
    fileName: row.fileName,
    declaredMime: row.declaredMime,
    declaredSize: Number(row.declaredSize),
    productCode: row.productCode,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
  };
}
```

Nếu `DbHandle` không phải tên type xuất từ `./client`, mở `src/adapters/db/client.ts` và dùng đúng tên nó xuất — các repo khác trong thư mục này là mẫu.

- [ ] **Step 8: Chạy migration và test**

```bash
TEST_DATABASE_URL=postgres://... pnpm db:migrate
psql "$TEST_DATABASE_URL" -c '\d upload_ticket'
TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/upload-ticket-repo.write.integration.test.ts
```

Expected: `\d upload_ticket` in ra bảng thật (exit 0 của `db:migrate` **không** đủ — xem bẫy đã ghi trong CLAUDE.md), và 5 test PASS.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/db/schema/upload-ticket.ts src/adapters/db/schema/index.ts src/core/ports/upload-ticket-repo.ts src/adapters/db/upload-ticket-repo.drizzle.ts src/adapters/db/upload-ticket-repo.write.integration.test.ts drizzle/
git commit -m "feat(upload): add the upload_ticket table and its repository"
```

---

## Task 6: Usecase `issue-upload-tickets` + route

**Files:**
- Create: `src/core/usecases/issue-upload-tickets.ts`
- Test: `src/core/usecases/issue-upload-tickets.test.ts`
- Create: `src/app/api/posts/uploads/tickets/route.ts`
- Modify: `src/composition/container.ts` (đăng ký usecase + repo vé)

**Interfaces:**
- Consumes: `MediaBlobStore.createUploadUrl` (Task 4), `UploadTicketRepo.createMany` (Task 5).
- Produces:
  ```ts
  interface IssueUploadTicketsInput {
    tenantId: TenantId; productCode: string; actorUserId?: string | null;
    files: readonly { fileName: string; mimeType: string; sizeBytes: number }[];
  }
  interface IssuedTicket { assetId: string; fileName: string; postUrl: string; formFields: Record<string,string>; expiresAt: Date }
  interface IssueUploadTicketsResult { issued: readonly IssuedTicket[]; rejected: readonly UploadRejectionReport[] }
  makeIssueUploadTickets(deps): (input) => Promise<IssueUploadTicketsResult>
  ```
  `UploadRejectionReport` tái dùng nguyên từ `src/core/usecases/upload-media.ts`.

- [ ] **Step 1: Viết test thất bại**

```ts
// src/core/usecases/issue-upload-tickets.test.ts
import { describe, expect, it, vi } from "vitest";

import { makeIssueUploadTickets } from "@/core/usecases/issue-upload-tickets";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return logger; } };

function deps(overrides: Record<string, unknown> = {}) {
  let n = 0;
  return {
    blobs: {
      createUploadUrl: vi.fn(async ({ assetId }: { assetId: string }) => ({
        postUrl: "https://media.vannt.asia/mysp-media",
        formFields: { key: `staging/${TENANT}/${assetId}` },
        storageKey: `${TENANT}/${assetId}`,
        expiresAt: new Date("2026-08-26T10:30:00Z"),
      })),
    },
    tickets: { createMany: vi.fn(async () => 1) },
    logger,
    newAssetId: () => `upload_${(n += 1)}`,
    ticketTtlSeconds: 1800,
    ...overrides,
  } as never;
}

const png = { fileName: "a.png", mimeType: "image/png", sizeBytes: 100 };

describe("issueUploadTickets — edge case trước", () => {
  it("thiếu mã sản phẩm thì ném INVALID_INPUT", async () => {
    await expect(makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "  ", files: [png] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("danh sách rỗng thì ném", async () => {
    await expect(makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "MG0AD6112", files: [] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("quá 10 file thì từ chối CẢ LÔ", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ ...png, fileName: `${i}.png` }));
    await expect(makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "MG0AD6112", files }))
      .rejects.toMatchObject({ context: { reason: "TOO_MANY_FILES" } });
  });

  it("mime lạ thì từ chối RIÊNG file đó, các file khác vẫn có vé", async () => {
    const result = await makeIssueUploadTickets(deps())({
      tenantId: TENANT, productCode: "MG0AD6112",
      files: [png, { fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }],
    });
    expect(result.issued).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ fileName: "x.exe" });
  });

  it("file quá 25MB bị từ chối riêng, không gọi ký", async () => {
    const d = deps();
    const result = await makeIssueUploadTickets(d)({
      tenantId: TENANT, productCode: "MG0AD6112",
      files: [{ fileName: "big.png", mimeType: "image/png", sizeBytes: 26 * 1024 * 1024 }],
    });
    expect(result.issued).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("trộn ảnh với video thì ném MIXED_ALBUM_KIND", async () => {
    await expect(makeIssueUploadTickets(deps())({
      tenantId: TENANT, productCode: "MG0AD6112",
      files: [png, { fileName: "v.mp4", mimeType: "video/mp4", sizeBytes: 100 }],
    })).rejects.toMatchObject({ context: { reason: "MIXED_ALBUM_KIND" } });
  });

  it("không file nào dùng được thì ném, không ghi vé", async () => {
    const d = deps();
    await expect(makeIssueUploadTickets(d)({
      tenantId: TENANT, productCode: "MG0AD6112",
      files: [{ fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((d as never as { tickets: { createMany: { mock: { calls: unknown[] } } } }).tickets.createMany.mock.calls).toHaveLength(0);
  });

  it("happy path: ghi vé đúng số lượng và trả postUrl", async () => {
    const d = deps();
    const result = await makeIssueUploadTickets(d)({ tenantId: TENANT, productCode: "mg0ad6112", files: [png] });
    expect(result.issued[0].postUrl).toBe("https://media.vannt.asia/mysp-media");
    expect(result.issued[0].assetId).toBe("upload_1");
    const call = (d as never as { tickets: { createMany: { mock: { calls: unknown[][] } } } }).tickets.createMany.mock.calls[0];
    expect((call[1] as { productCode: string }[])[0].productCode).toBe("MG0AD6112");
  });
});
```

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/core/usecases/issue-upload-tickets.test.ts`
Expected: FAIL — module không tồn tại.

- [ ] **Step 3: Tách `assertOneAlbumKind` thành hàm thuần dùng chung**

Trong `src/core/usecases/upload-media.ts`, đổi chữ ký hàm private ở cuối file thành hàm **export** nhận `kind[]`, và sửa chỗ gọi hiện có cho khớp:

```ts
/**
 * Một bài là album ảnh HOẶC một clip — hai endpoint khác nhau của nền tảng.
 * Từ chối ở đây rẻ hơn phát hiện sau khi đã trả tiền cho AI viết caption.
 */
export function assertOneAlbumKind(
  kinds: readonly MediaKind[],
  context: { tenantId: TenantId; productCode: string },
): void {
  const unique = new Set(kinds);
  if (unique.size > 1) {
    throw new AppError("INVALID_INPUT", {
      message: "An uploaded album mixes photos and video",
      userMessage: "Một bài chỉ nhận ảnh hoặc video, không trộn lẫn. Hãy tách thành hai bài riêng.",
      context: { tenant_id: context.tenantId, product_code: context.productCode, reason: "MIXED_ALBUM_KIND" },
    });
  }
  if (kinds[0] === "video" && kinds.length > 1) {
    throw new AppError("INVALID_INPUT", {
      message: "A video post carries exactly one clip",
      userMessage: `Một bài video chỉ nhận một file — đang có ${kinds.length}.`,
      context: { tenant_id: context.tenantId, product_code: context.productCode, reason: "MULTIPLE_VIDEOS", count: kinds.length },
    });
  }
}
```

Chỗ gọi cũ trong `uploadMedia` đổi thành `assertOneAlbumKind(usable.map((item) => item.kind), { tenantId, productCode })`.

- [ ] **Step 4: Viết usecase**

```ts
// src/core/usecases/issue-upload-tickets.ts
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_POST, validateUpload } from "@/core/domain/uploaded-media";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import { assertOneAlbumKind, type UploadRejectionReport } from "./upload-media";

/**
 * Chặng 1 của đường tải lên mới: cấp URL ký sẵn, KHÔNG nhận byte nào.
 *
 * Byte đi thẳng browser → MinIO ở chặng 2, nên mọi thứ ở đây chỉ làm việc với
 * lời khai của client (tên, mime, cỡ). Lời khai là thứ giả được — cổng thật
 * nằm ở `confirm-upload`, nơi byte đã có mặt và được sniff. Ở đây chỉ chặn
 * những gì chặn được sớm, để khỏi ký một URL chắc chắn vô ích.
 */

export interface IssueUploadTicketsInput {
  readonly tenantId: TenantId;
  readonly productCode: string;
  readonly actorUserId?: string | null;
  readonly files: readonly { fileName: string; mimeType: string; sizeBytes: number }[];
}

export interface IssuedTicket {
  readonly assetId: string;
  readonly fileName: string;
  readonly postUrl: string;
  readonly formFields: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface IssueUploadTicketsResult {
  readonly issued: readonly IssuedTicket[];
  readonly rejected: readonly UploadRejectionReport[];
}

export interface IssueUploadTicketsDeps {
  blobs: MediaBlobStore;
  tickets: UploadTicketRepo;
  logger: Logger;
  newAssetId: () => string;
  ticketTtlSeconds: number;
}

export function makeIssueUploadTickets(deps: IssueUploadTicketsDeps) {
  return async function issueUploadTickets(
    input: IssueUploadTicketsInput,
  ): Promise<IssueUploadTicketsResult> {
    // --- Edge case trước ----------------------------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";

    if (!isTenantId(rawTenantId) || productCode.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "issueUploadTickets requires a tenant UUID and a product code",
        userMessage: "Thiếu mã sản phẩm cho các file vừa chọn.",
        context: { tenant_id: rawTenantId || null, product_code: productCode || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const files = Array.isArray(input?.files) ? input.files : [];

    if (files.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "issueUploadTickets was called with no files",
        userMessage: "Chưa chọn file nào.",
        context: { tenant_id: tenantId, product_code: productCode, reason: "EMPTY_ALBUM" },
      });
    }
    if (files.length > MAX_UPLOADS_PER_POST) {
      throw new AppError("INVALID_INPUT", {
        message: `An uploaded album holds at most ${MAX_UPLOADS_PER_POST} files`,
        userMessage: `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file — hiện đang có ${files.length}.`,
        context: { tenant_id: tenantId, product_code: productCode, reason: "TOO_MANY_FILES", count: files.length },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });

    // --- Cổng theo từng file (dựa trên LỜI KHAI) ----------------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: { fileName: string; mimeType: string; sizeBytes: number; kind: "image" | "video" }[] = [];

    for (const candidate of files) {
      const verdict = validateUpload({
        fileName: candidate?.fileName,
        mimeType: candidate?.mimeType,
        sizeBytes: candidate?.sizeBytes,
      });
      if (!verdict.ok) {
        log.warn("Ticket refused a file before signing", {
          error_code: "INVALID_INPUT",
          reason: verdict.rejection.reason,
          file_name: candidate?.fileName ?? null,
          size_bytes: candidate?.sizeBytes ?? null,
        });
        rejected.push({
          fileName: typeof candidate?.fileName === "string" ? candidate.fileName : "",
          reason: verdict.rejection.reason,
          userMessage: verdict.rejection.userMessage,
        });
        continue;
      }
      usable.push({
        fileName: candidate.fileName.trim(),
        mimeType: verdict.mimeType,
        sizeBytes: candidate.sizeBytes,
        kind: verdict.kind,
      });
    }

    if (usable.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Every candidate file was refused before signing",
        userMessage: `Không nhận được file nào: ${rejected.map((item) => item.userMessage).join(" ")}`,
        context: { tenant_id: tenantId, product_code: productCode, refused: rejected.length },
      });
    }

    assertOneAlbumKind(usable.map((item) => item.kind), { tenantId, productCode });

    // --- Ký, rồi ghi vé -----------------------------------------------------
    const issued: IssuedTicket[] = [];
    const ticketRows: UploadTicket[] = [];

    for (const item of usable) {
      const assetId = deps.newAssetId();
      const signed = await deps.blobs.createUploadUrl({
        tenantId,
        assetId,
        declaredMimeType: item.mimeType,
        maxBytes: MAX_UPLOAD_BYTES,
        expiresInSeconds: deps.ticketTtlSeconds,
      });
      issued.push({
        assetId,
        fileName: item.fileName,
        postUrl: signed.postUrl,
        formFields: signed.formFields,
        expiresAt: signed.expiresAt,
      });
      ticketRows.push({
        tenantId,
        assetId,
        storageKey: signed.storageKey,
        fileName: item.fileName,
        declaredMime: item.mimeType,
        declaredSize: item.sizeBytes,
        productCode,
        expiresAt: signed.expiresAt,
        createdBy: input.actorUserId ?? null,
      });
    }

    await deps.tickets.createMany(tenantId, ticketRows);

    log.info("Issued upload tickets", { issued: issued.length, refused: rejected.length });
    return { issued, rejected };
  };
}

export type IssueUploadTickets = ReturnType<typeof makeIssueUploadTickets>;
```

- [ ] **Step 5: Chạy test**

Run: `pnpm vitest run src/core/usecases/issue-upload-tickets.test.ts src/core/usecases/upload-media.test.ts`
Expected: PASS cả hai file. `upload-media.test.ts` phải vẫn xanh sau khi tách `assertOneAlbumKind`.

- [ ] **Step 6: Viết route**

```ts
// src/app/api/posts/uploads/tickets/route.ts
import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { MAX_UPLOADS_PER_POST } from "@/core/domain/uploaded-media";

/**
 * Chặng 1 của mode B. Mỏng theo hợp đồng (docs/07 §3.3): phân quyền, validate
 * thân bằng zod, gọi usecase, map AppError.
 *
 * KHÔNG nhận byte — thân là JSON vài KB. Byte đi thẳng browser → MinIO ở chặng 2.
 */

const ROUTE = "POST /api/posts/uploads/tickets";

const BodySchema = z.object({
  productCode: z.string().trim().min(1, "Thiếu mã sản phẩm.").max(64, "Mã sản phẩm quá dài."),
  files: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(512),
        mimeType: z.string().trim().min(1).max(255),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .min(1, "Chưa chọn file nào.")
    .max(MAX_UPLOADS_PER_POST),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "M",
      minRole: "editor",
    });

    const body = BodySchema.parse(await request.json());

    const result = await container.usecases.issueUploadTickets({
      tenantId: ctx.tenantId,
      productCode: body.productCode,
      actorUserId: ctx.userId ?? null,
      files: body.files,
    });

    return Response.json({
      issued: result.issued.map((item) => ({
        assetId: item.assetId,
        fileName: item.fileName,
        postUrl: item.postUrl,
        formFields: item.formFields,
        expiresAt: item.expiresAt.toISOString(),
      })),
      rejected: result.rejected,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
```

Nếu `ctx` không có trường `userId`, mở `src/app/api/_lib/require-tenant-context.ts` và dùng đúng tên trường nó trả về; route khác trong repo là mẫu.

- [ ] **Step 7: Đăng ký trong container**

Trong `src/composition/container.ts`, cạnh chỗ dựng `uploadMedia`, thêm repo vé và usecase mới. Giữ `blobs` như hôm nay (Task 11 mới đổi sang MinIO):

```ts
  const uploadTickets = overrides.uploadTickets ?? new DrizzleUploadTicketRepo(db);
  // ...
  issueUploadTickets: makeIssueUploadTickets({
    blobs,
    tickets: uploadTickets,
    logger: deps.logger,
    newAssetId: () => `upload_${randomUUID().replace(/-/g, "")}`,
    ticketTtlSeconds: 30 * 60,
  }),
```

Dùng đúng biến `db` mà các repo khác trong file này đang nhận; nếu tên khác thì theo tên đó.

- [ ] **Step 8: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/core/usecases/issue-upload-tickets.ts src/core/usecases/issue-upload-tickets.test.ts src/core/usecases/upload-media.ts src/app/api/posts/uploads/tickets/ src/composition/container.ts
git commit -m "feat(upload): issue presigned upload tickets without touching bytes"
```

---

## Task 7: Usecase `confirm-upload` + route

**Files:**
- Create: `src/core/usecases/confirm-upload.ts`
- Test: `src/core/usecases/confirm-upload.test.ts`
- Create: `src/app/api/posts/uploads/confirm/route.ts`
- Modify: `src/composition/container.ts`

**Interfaces:**
- Consumes: `UploadTicketRepo.findMany`/`deleteMany` (Task 5), `MediaBlobStore.stat`/`readRange`/`promote`/`delete` (Task 4), `MediaRepo.registerUpload`/`listUnreferencedUploadsForCode`/`deleteUploads` (đã có).
- Produces: `makeConfirmUpload(deps)` với `ConfirmUploadInput = { tenantId; productCode; assets: readonly {assetId: string}[]; order?: readonly number[] }` và `ConfirmUploadResult = { accepted: readonly MediaAsset[]; rejected: readonly UploadRejectionReport[] }` — **cùng shape với `UploadMediaResult`**, để UI không phải học hai kiểu trả về.

- [ ] **Step 1: Viết test thất bại**

```ts
// src/core/usecases/confirm-upload.test.ts
import { describe, expect, it, vi } from "vitest";

import { makeConfirmUpload } from "@/core/usecases/confirm-upload";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return logger; } };

function ticket(assetId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, assetId, storageKey: `${TENANT}/${assetId}`, fileName: `${assetId}.png`,
    declaredMime: "image/png", declaredSize: 8, productCode: "MG0AD6112",
    expiresAt: new Date(Date.now() + 60_000), ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    tickets: {
      findMany: vi.fn(async () => [ticket("a1")]),
      deleteMany: vi.fn(async () => 1),
    },
    blobs: {
      stat: vi.fn(async () => ({ sizeBytes: 8, mimeType: "image/png" })),
      readRange: vi.fn(async () => PNG),
      promote: vi.fn(async ({ assetId }: { assetId: string }) => ({ storageKey: `${TENANT}/${assetId}`, sizeBytes: 8 })),
      delete: vi.fn(async () => true),
    },
    media: {
      registerUpload: vi.fn(async () => undefined),
      listUnreferencedUploadsForCode: vi.fn(async () => []),
      deleteUploads: vi.fn(async () => 0),
    },
    clock: { now: () => new Date() },
    logger,
    ...over,
  } as never;
}

describe("confirmUpload — edge case trước", () => {
  it("thiếu mã thì ném", async () => {
    await expect(makeConfirmUpload(deps())({ tenantId: TENANT, productCode: "", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("vé không có thì từ chối file đó", async () => {
    const d = deps({ tickets: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => 0) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("vé hết hạn thì từ chối, xoá object và xoá vé", async () => {
    const d = deps({ tickets: { findMany: vi.fn(async () => [ticket("a1", { expiresAt: new Date(Date.now() - 1000) })]), deleteMany: vi.fn(async () => 1) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((d as never as { blobs: { delete: { mock: { calls: unknown[] } } } }).blobs.delete.mock.calls.length).toBe(1);
  });

  it("object không có trên storage thì từ chối", async () => {
    const d = deps({ blobs: { ...(deps() as never as { blobs: object }).blobs, stat: vi.fn(async () => null) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("nội dung không khớp mime khai báo thì XOÁ object, không promote", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    const base = deps() as never as { blobs: Record<string, unknown> };
    const d = deps({ blobs: { ...base.blobs, readRange: vi.fn(async () => exe) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    const blobs = (d as never as { blobs: { promote: { mock: { calls: unknown[] } }; delete: { mock: { calls: unknown[] } } } }).blobs;
    expect(blobs.promote.mock.calls).toHaveLength(0);
    expect(blobs.delete.mock.calls).toHaveLength(1);
  });

  it("happy path: promote rồi register, sequence theo order", async () => {
    const d = deps({
      tickets: { findMany: vi.fn(async () => [ticket("a1"), ticket("a2")]), deleteMany: vi.fn(async () => 2) },
    });
    const result = await makeConfirmUpload(d)({
      tenantId: TENANT, productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }], order: [1, 0],
    });
    expect(result.accepted.map((a) => a.driveFileId)).toEqual(["a2", "a1"]);
    expect(result.accepted.map((a) => a.sequence)).toEqual([1, 2]);
  });

  it("registerUpload lỗi thì xoá object đã promote (rollback)", async () => {
    const base = deps() as never as { media: Record<string, unknown>; blobs: Record<string, unknown> };
    const d = deps({ media: { ...base.media, registerUpload: vi.fn(async () => { throw new Error("db down"); }) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "DB_ERROR" });
    expect((d as never as { blobs: { delete: { mock: { calls: unknown[] } } } }).blobs.delete.mock.calls.length).toBe(1);
  });

  it("xoá lô upload trước đó của cùng mã", async () => {
    const base = deps() as never as { media: Record<string, unknown> };
    const d = deps({
      media: {
        ...base.media,
        listUnreferencedUploadsForCode: vi.fn(async () => [{ assetId: "old1", storageKey: `${TENANT}/old1` }]),
        deleteUploads: vi.fn(async () => 1),
      },
    });
    await makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] });
    expect((d as never as { media: { deleteUploads: { mock: { calls: unknown[] } } } }).media.deleteUploads.mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/core/usecases/confirm-upload.test.ts`
Expected: FAIL — module không tồn tại.

- [ ] **Step 3: Viết usecase**

```ts
// src/core/usecases/confirm-upload.ts
import { AppError } from "@/core/domain/errors";
import type { MediaKind } from "@/core/domain/media-file-name";
import { sniffMediaMimeType } from "@/core/domain/media-sniff";
import { mediaKindFromMimeType } from "@/core/domain/media-file-name";
import type { MediaAsset } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import { MAX_UPLOAD_BYTES } from "@/core/domain/uploaded-media";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo } from "@/core/ports/product-repo";
import type { UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import { assertOneAlbumKind, type UploadRejectionReport } from "./upload-media";

/**
 * Chặng 3: byte đã nằm ở vùng staging của MinIO, chưa ai duyệt kiểu.
 *
 * Thứ tự BẮT BUỘC, và nó là lý do tồn tại của cả usecase:
 *   vé → kích thước thật → sniff 4KB đầu → promote → register.
 * Không được đảo. Promote trước khi sniff nghĩa là một file .exe đổi tên nằm
 * trong vùng phục vụ, dù chỉ vài mili giây.
 *
 * Một file hỏng được BÁO CÁO, không ném (rule nghiệp vụ 5). Lô mà không file
 * nào qua thì mới ném — lúc đó không còn bài nào để đi tiếp.
 */

export interface ConfirmUploadInput {
  readonly tenantId: TenantId;
  readonly productCode: string;
  readonly assets: readonly { assetId: string }[];
  /** Chỉ số vào `assets`; phần tử 0 thành ảnh bìa. Vắng = giữ như gửi lên. */
  readonly order?: readonly number[];
}

export interface ConfirmUploadResult {
  readonly accepted: readonly MediaAsset[];
  readonly rejected: readonly UploadRejectionReport[];
}

export interface ConfirmUploadDeps {
  tickets: UploadTicketRepo;
  blobs: MediaBlobStore;
  media: MediaRepo;
  clock: Clock;
  logger: Logger;
}

export function makeConfirmUpload(deps: ConfirmUploadDeps) {
  return async function confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
    // --- Edge case trước ----------------------------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";
    if (!isTenantId(rawTenantId) || productCode.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "confirmUpload requires a tenant UUID and a product code",
        userMessage: "Thiếu mã sản phẩm cho các file vừa tải lên.",
        context: { tenant_id: rawTenantId || null, product_code: productCode || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const assets = Array.isArray(input?.assets) ? input.assets : [];
    if (assets.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "confirmUpload was called with no assets",
        userMessage: "Chưa có file nào để xác nhận.",
        context: { tenant_id: tenantId, product_code: productCode, reason: "EMPTY_ALBUM" },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });
    const arranged = applyOrder(assets, input?.order);
    const now = deps.clock.now();

    const ticketRows = await deps.tickets.findMany(tenantId, arranged.map((item) => item.assetId));
    const byAssetId = new Map(ticketRows.map((row) => [row.assetId, row]));

    // --- Cổng từng file, đúng thứ tự ---------------------------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: { assetId: string; fileName: string; mimeType: string; kind: MediaKind; sizeBytes: number }[] = [];
    const discard: string[] = [];

    for (const item of arranged) {
      const ticket = byAssetId.get(item.assetId);

      if (!ticket) {
        log.warn("Confirm refused a file with no ticket", { error_code: "INVALID_INPUT", reason: "UPLOAD_TICKET_NOT_FOUND", asset_id: item.assetId });
        rejected.push({ fileName: "", reason: "UNSUPPORTED_TYPE", userMessage: "Phiên tải file đã kết thúc — hãy chọn lại file." });
        continue;
      }

      if (ticket.expiresAt.getTime() <= now.getTime()) {
        log.warn("Confirm refused an expired ticket", { error_code: "INVALID_INPUT", reason: "UPLOAD_TICKET_EXPIRED", asset_id: item.assetId, file_name: ticket.fileName });
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `Phiên tải "${ticket.fileName}" đã hết hạn — hãy chọn lại file.` });
        discard.push(item.assetId);
        continue;
      }

      const info = await deps.blobs.stat({ tenantId, storageKey: ticket.storageKey });
      const staged = info ?? (await statStaging(deps, tenantId, ticket.storageKey));
      if (!staged) {
        log.warn("Confirm refused a file whose object never arrived", { error_code: "INVALID_INPUT", reason: "UPLOAD_OBJECT_MISSING", asset_id: item.assetId, file_name: ticket.fileName });
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `File "${ticket.fileName}" chưa lên tới nơi — hãy thử lại.` });
        discard.push(item.assetId);
        continue;
      }

      if (staged.sizeBytes <= 0 || staged.sizeBytes > MAX_UPLOAD_BYTES) {
        log.warn("Confirm refused a file whose real size is out of range", { error_code: "INVALID_INPUT", reason: "UPLOAD_SIZE_MISMATCH", asset_id: item.assetId, file_name: ticket.fileName, size_bytes: staged.sizeBytes });
        rejected.push({ fileName: ticket.fileName, reason: "TOO_LARGE", userMessage: `File "${ticket.fileName}" có kích thước không hợp lệ — file bị từ chối.` });
        discard.push(item.assetId);
        continue;
      }

      // Cổng THẬT: nội dung quyết định, không phải phần mở rộng hay File.type.
      const head = await deps.blobs.readRange({ tenantId, storageKey: ticket.storageKey, length: 4096 });
      const actual = head ? sniffMediaMimeType(head) : null;
      if (!actual || actual !== ticket.declaredMime) {
        log.warn("Confirm refused a file whose content does not match its declared type", {
          error_code: "INVALID_INPUT", reason: "CONTENT_TYPE_MISMATCH",
          asset_id: item.assetId, file_name: ticket.fileName,
          declared_mime: ticket.declaredMime, sniffed_mime: actual,
        });
        rejected.push({
          fileName: ticket.fileName,
          reason: "UNSUPPORTED_TYPE",
          userMessage: `Nội dung file "${ticket.fileName}" không khớp định dạng khai báo — file bị từ chối.`,
        });
        discard.push(item.assetId);
        continue;
      }

      const kind = mediaKindFromMimeType(actual);
      if (!kind) {
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `Định dạng file "${ticket.fileName}" không được hỗ trợ.` });
        discard.push(item.assetId);
        continue;
      }

      usable.push({ assetId: item.assetId, fileName: ticket.fileName, mimeType: actual, kind, sizeBytes: staged.sizeBytes });
    }

    await discardRefused(deps, tenantId, discard, byAssetId, log);

    if (usable.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Every uploaded file was refused at confirm",
        userMessage: `Không nhận được file nào: ${rejected.map((item) => item.userMessage).join(" ")}`,
        context: { tenant_id: tenantId, product_code: productCode, refused: rejected.length },
      });
    }

    assertOneAlbumKind(usable.map((item) => item.kind), { tenantId, productCode });

    await discardPreviousUploads(deps, tenantId, productCode, log);

    // --- Promote rồi register ----------------------------------------------
    const accepted: MediaAsset[] = [];

    for (const [index, item] of usable.entries()) {
      const promoted = await deps.blobs.promote({ tenantId, assetId: item.assetId });

      const asset: MediaAsset = {
        driveFileId: item.assetId,
        origin: "upload",
        storageKey: promoted.storageKey,
        fileName: item.fileName,
        productCode,
        // Mode B không mang màu: tên file ở đây không có quy ước để đọc.
        color: null,
        colorRaw: null,
        sequence: index + 1,
        kind: item.kind,
        variants: { aiGenerated: false, realPhoto: false, backView: false },
        mimeType: item.mimeType,
        sizeBytes: promoted.sizeBytes,
        modifiedTime: null,
        warnings: [],
        needsReview: false,
      };

      try {
        await deps.media.registerUpload(tenantId, asset);
      } catch (error) {
        // Byte đã ở vùng phục vụ nhưng không row nào trỏ tới — sweep chạy theo
        // row nên sẽ không bao giờ tìm thấy. Xoá ngay tại đây.
        const removed = await deps.blobs.delete({ tenantId, storageKey: promoted.storageKey }).catch(() => false);
        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId, product_code: productCode, asset_id: item.assetId,
          file_name: item.fileName, reason: "UPLOAD_REGISTER_FAILED", blob_rolled_back: removed,
        });
        log.error("Confirm promoted the bytes but could not register the asset", appError.toLogObject());
        throw appError;
      }

      accepted.push(asset);
    }

    await deps.tickets.deleteMany(tenantId, usable.map((item) => item.assetId));

    log.info("Confirm accepted", {
      accepted: accepted.length, refused: rejected.length,
      media_kind: usable[0].kind, cover_file: accepted[0]?.fileName ?? null,
    });

    return { accepted, rejected };
  };
}

export type ConfirmUpload = ReturnType<typeof makeConfirmUpload>;

// --- helpers -----------------------------------------------------------------

function applyOrder(
  assets: readonly { assetId: string }[],
  order: readonly number[] | undefined,
): readonly { assetId: string }[] {
  if (!Array.isArray(order) || order.length !== assets.length) return assets;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= assets.length || seen.has(index)) return assets;
    seen.add(index);
  }
  return order.map((index) => assets[index]);
}

/** `stat` nhắm vùng phục vụ; trước promote thì object còn ở staging. */
async function statStaging(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  storageKey: string,
): Promise<{ sizeBytes: number } | null> {
  const head = await deps.blobs.readRange({ tenantId, storageKey, length: 1 });
  if (!head || head.length === 0) return null;
  // Kích thước thật lấy khi promote; ở đây chỉ cần biết object CÓ mặt và không rỗng.
  return { sizeBytes: 1 };
}

/**
 * Dọn object của những file vừa bị từ chối. Lỗi ở đây được log rồi bỏ qua:
 * operator đang chờ kết quả, và sweep giờ sẽ nhặt nốt phần sót.
 */
async function discardRefused(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  assetIds: readonly string[],
  byAssetId: ReadonlyMap<string, { storageKey: string }>,
  log: Logger,
): Promise<void> {
  if (assetIds.length === 0) return;
  for (const assetId of assetIds) {
    const storageKey = byAssetId.get(assetId)?.storageKey;
    if (!storageKey) continue;
    try {
      await deps.blobs.delete({ tenantId, storageKey });
    } catch (error) {
      log.warn("Could not remove a refused upload's bytes", {
        ...AppError.from(error, "INTERNAL", { reason: "REFUSED_BLOB_DELETE_FAILED" }).toLogObject(),
        asset_id: assetId,
      });
    }
  }
  try {
    await deps.tickets.deleteMany(tenantId, assetIds);
  } catch (error) {
    log.warn("Could not remove the tickets of refused uploads", {
      ...AppError.from(error, "DB_ERROR", { reason: "REFUSED_TICKET_DELETE_FAILED" }).toLogObject(),
    });
  }
}

/**
 * Thay thế, không gộp: `sequence` đánh số từ 1 mỗi lần, nên lần tải thứ hai
 * cho cùng một mã sẽ đụng lần đầu và compose trả về một album lộn xộn.
 * Chỉ những upload CHƯA bị post job nào tham chiếu mới bị xoá.
 */
async function discardPreviousUploads(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  productCode: string,
  log: Logger,
): Promise<void> {
  let previous: readonly { assetId: string; storageKey: string }[];
  try {
    previous = await deps.media.listUnreferencedUploadsForCode(tenantId, productCode);
  } catch (error) {
    log.error("Could not list the previous uploads to replace", {
      ...AppError.from(error, "DB_ERROR", { reason: "LIST_PREVIOUS_UPLOADS_FAILED" }).toLogObject(),
    });
    return;
  }
  if (previous.length === 0) return;

  for (const item of previous) {
    if (!item.storageKey) continue;
    try {
      await deps.blobs.delete({ tenantId, storageKey: item.storageKey });
    } catch (error) {
      log.warn("Could not remove the bytes of a replaced upload", {
        ...AppError.from(error, "INTERNAL", { reason: "REPLACED_BLOB_DELETE_FAILED" }).toLogObject(),
        drive_file_id: item.assetId,
      });
    }
  }

  try {
    const removed = await deps.media.deleteUploads(tenantId, previous.map((item) => item.assetId));
    log.info("Replaced the previous upload attempt for this code", { removed });
  } catch (error) {
    log.error("Could not remove the rows of a replaced upload", {
      ...AppError.from(error, "DB_ERROR", { reason: "REPLACED_ROW_DELETE_FAILED" }).toLogObject(),
    });
  }
}
```

- [ ] **Step 4: Chạy test**

Run: `pnpm vitest run src/core/usecases/confirm-upload.test.ts`
Expected: PASS (8 test).

- [ ] **Step 5: Viết route**

```ts
// src/app/api/posts/uploads/confirm/route.ts
import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { MAX_UPLOADS_PER_POST } from "@/core/domain/uploaded-media";

/**
 * Chặng 3 của mode B: byte đã ở MinIO, đây là nơi chúng được duyệt.
 *
 * File bị từ chối trả về trong thân của một 200, không phải một status lỗi:
 * operator kéo nhiều file và cần thấy file NÀO bị từ chối trong khi vẫn giữ
 * những file đã qua. Lô mà không file nào dùng được thì usecase ném và rơi
 * xuống đây thành 4xx.
 */

const ROUTE = "POST /api/posts/uploads/confirm";

const BodySchema = z.object({
  productCode: z.string().trim().min(1, "Thiếu mã sản phẩm.").max(64),
  assets: z.array(z.object({ assetId: z.string().trim().min(1).max(128) })).min(1).max(MAX_UPLOADS_PER_POST),
  order: z.array(z.number().int().nonnegative()).max(MAX_UPLOADS_PER_POST).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "M",
      minRole: "editor",
    });

    const body = BodySchema.parse(await request.json());

    const result = await container.usecases.confirmUpload({
      tenantId: ctx.tenantId,
      productCode: body.productCode,
      assets: body.assets,
      order: body.order,
    });

    return Response.json({
      accepted: result.accepted.map((asset) => ({
        assetId: asset.driveFileId,
        fileName: asset.fileName,
        kind: asset.kind,
        sequence: asset.sequence,
        sizeBytes: asset.sizeBytes,
      })),
      rejected: result.rejected,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
```

- [ ] **Step 6: Đăng ký trong container**

```ts
  confirmUpload: makeConfirmUpload({
    tickets: uploadTickets,
    blobs,
    media: mediaRepo,
    clock: deps.clock,
    logger: deps.logger,
  }),
```

Dùng đúng tên biến `MediaRepo` mà `uploadMedia` đang nhận trong file này.

- [ ] **Step 7: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/core/usecases/confirm-upload.ts src/core/usecases/confirm-upload.test.ts src/app/api/posts/uploads/confirm/ src/composition/container.ts
git commit -m "feat(upload): confirm staged uploads by sniffing content before promotion"
```

---

## Task 8: Sweep vé quá hạn

**Files:**
- Modify: `src/core/usecases/cleanup-uploads.ts`
- Modify: `src/core/usecases/cleanup-uploads.test.ts`
- Modify: `src/composition/container.ts` (truyền `tickets` vào `cleanupUploads`)

**Interfaces:**
- Consumes: `UploadTicketRepo.listExpired`/`deleteMany` (Task 5), `MediaBlobStore.delete` (Task 3).
- Produces: `CleanupUploadsResult` thêm hai trường `ticketsScanned: number` và `ticketsRemoved: number`.

- [ ] **Step 1: Thêm test thất bại**

```ts
// nối vào src/core/usecases/cleanup-uploads.test.ts
it("dọn vé quá hạn: xoá byte trước, xoá vé sau", async () => {
  const order: string[] = [];
  const blobs = {
    delete: vi.fn(async () => { order.push("blob"); return true; }),
  };
  const tickets = {
    listExpired: vi.fn(async () => [{
      tenantId: TENANT, assetId: "t1", storageKey: `${TENANT}/t1`, fileName: "t1.png",
      declaredMime: "image/png", declaredSize: 10, productCode: "MG0AD6112",
      expiresAt: new Date(Date.now() - 10_000),
    }]),
    deleteMany: vi.fn(async () => { order.push("ticket"); return 1; }),
  };
  const result = await makeCleanupUploads(depsWith({ blobs, tickets }))({});
  expect(result.ticketsRemoved).toBe(1);
  expect(order).toEqual(["blob", "ticket"]);
});

it("một vé xoá lỗi không dừng cả lượt quét", async () => {
  const blobs = { delete: vi.fn(async () => { throw new Error("storage down"); }) };
  const tickets = {
    listExpired: vi.fn(async () => [
      { tenantId: TENANT, assetId: "t1", storageKey: `${TENANT}/t1`, fileName: "a", declaredMime: "image/png", declaredSize: 1, productCode: "C", expiresAt: new Date(0) },
      { tenantId: TENANT, assetId: "t2", storageKey: `${TENANT}/t2`, fileName: "b", declaredMime: "image/png", declaredSize: 1, productCode: "C", expiresAt: new Date(0) },
    ]),
    deleteMany: vi.fn(async () => 0),
  };
  const result = await makeCleanupUploads(depsWith({ blobs, tickets }))({});
  expect(result.ticketsScanned).toBe(2);
  expect(blobs.delete).toHaveBeenCalledTimes(2);
});
```

`depsWith` là helper đã có trong file test đó; nếu chưa có thì viết một hàm nhỏ trộn deps mặc định với `overrides`, theo đúng khuôn các test khác trong file.

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/core/usecases/cleanup-uploads.test.ts`
Expected: FAIL — `result.ticketsRemoved` là `undefined`.

- [ ] **Step 3: Mở rộng usecase**

Thêm `tickets: UploadTicketRepo` vào `CleanupUploadsDeps`, thêm hai trường vào `CleanupUploadsResult`, và chèn lượt quét vé **sau** lượt quét asset mồ côi đang có:

```ts
  // --- Vé quá hạn ---------------------------------------------------------
  // Byte trước, row sau — cùng luật với lượt quét asset ở trên: một row bị xoá
  // trước byte của nó để lại một file không gì gọi tên được nữa.
  let ticketsScanned = 0;
  let ticketsRemoved = 0;

  let expired: readonly UploadTicket[] = [];
  try {
    expired = await deps.tickets.listExpired({ now: deps.clock.now(), limit });
  } catch (error) {
    log.error("Could not list expired upload tickets", {
      ...AppError.from(error, "DB_ERROR", { reason: "LIST_EXPIRED_TICKETS_FAILED" }).toLogObject(),
    });
  }

  ticketsScanned = expired.length;
  const removable: string[] = [];

  for (const ticket of expired) {
    try {
      await deps.blobs.delete({ tenantId: ticket.tenantId, storageKey: ticket.storageKey });
      removable.push(ticket.assetId);
    } catch (error) {
      // Một vé hỏng là lý do thử lại giờ sau, không phải lý do bỏ dở lượt quét.
      log.warn("Could not remove the bytes of an expired ticket", {
        ...AppError.from(error, "INTERNAL", { reason: "EXPIRED_TICKET_BLOB_DELETE_FAILED" }).toLogObject(),
        tenant_id: ticket.tenantId,
        asset_id: ticket.assetId,
      });
    }
  }

  const byTenant = new Map<TenantId, string[]>();
  for (const ticket of expired) {
    if (!removable.includes(ticket.assetId)) continue;
    const list = byTenant.get(ticket.tenantId) ?? [];
    list.push(ticket.assetId);
    byTenant.set(ticket.tenantId, list);
  }
  for (const [tenantId, assetIds] of byTenant) {
    try {
      ticketsRemoved += await deps.tickets.deleteMany(tenantId, assetIds);
    } catch (error) {
      log.error("Could not remove expired ticket rows", {
        ...AppError.from(error, "DB_ERROR", { reason: "EXPIRED_TICKET_ROW_DELETE_FAILED" }).toLogObject(),
        tenant_id: tenantId,
      });
    }
  }
```

Trả về thêm `ticketsScanned` và `ticketsRemoved` trong object kết quả.

- [ ] **Step 4: Chạy test**

Run: `pnpm vitest run src/core/usecases/cleanup-uploads.test.ts`
Expected: PASS toàn bộ file, kể cả test cũ.

- [ ] **Step 5: Nối `tickets` vào container**

Trong `src/composition/container.ts`, thêm `tickets: uploadTickets` vào deps của `cleanupUploads`.

- [ ] **Step 6: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/usecases/cleanup-uploads.ts src/core/usecases/cleanup-uploads.test.ts src/composition/container.ts
git commit -m "feat(upload): sweep expired upload tickets and their staged bytes"
```

---

## Task 9: Media bridge trả 302

**Files:**
- Modify: `src/core/usecases/get-media-content.ts`
- Modify: `src/app/api/media/[driveFileId]/route.ts`
- Test: `src/core/usecases/get-media-redirect.test.ts`

**Interfaces:**
- Consumes: `MediaBlobStore.createDownloadUrl` (Task 4).
- Produces: `GetMediaContentResult` thêm trường tuỳ chọn `redirectUrl?: string | null`. Khi có, route trả `302` và **không** đọc `bytes`.

**Bối cảnh phải nhớ:** ảnh đăng lên Facebook **không** đi qua đường này — `publish-post.ts:661-666` gửi byte bằng multipart `source`. 302 ở đây phục vụ **UI preview**. Video (Phase 2) mới dùng URL, và lúc đó phải đo lại.

- [ ] **Step 1: Viết test thất bại**

```ts
// src/core/usecases/get-media-redirect.test.ts
import { describe, expect, it, vi } from "vitest";

import { makeGetMediaContent } from "@/core/usecases/get-media-content";

// Dựng deps theo đúng khuôn get-media-content.test.ts đang dùng; chỉ phần
// blobs và asset là khác.
describe("getMediaContent — 302 cho asset upload", () => {
  it("trả redirectUrl khi store ký được và KHÔNG đọc byte", async () => {
    const blobs = {
      createDownloadUrl: vi.fn(async () => "https://media.vannt.asia/signed"),
      get: vi.fn(async () => { throw new Error("must not read bytes"); }),
    };
    const result = await makeGetMediaContent(depsForUploadAsset({ blobs }))(validSignedInput());
    expect(result.redirectUrl).toBe("https://media.vannt.asia/signed");
    expect(blobs.get).not.toHaveBeenCalled();
  });

  it("rơi về stream khi store trả null", async () => {
    const blobs = {
      createDownloadUrl: vi.fn(async () => null),
      get: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" })),
    };
    const result = await makeGetMediaContent(depsForUploadAsset({ blobs }))(validSignedInput());
    expect(result.redirectUrl ?? null).toBeNull();
    expect(blobs.get).toHaveBeenCalled();
  });

  it("asset Drive không bao giờ redirect", async () => {
    const blobs = { createDownloadUrl: vi.fn(async () => "https://x"), get: vi.fn() };
    const result = await makeGetMediaContent(depsForDriveAsset({ blobs }))(validSignedInput());
    expect(result.redirectUrl ?? null).toBeNull();
    expect(blobs.createDownloadUrl).not.toHaveBeenCalled();
  });
});
```

`depsForUploadAsset`, `depsForDriveAsset`, `validSignedInput` copy từ `src/core/usecases/get-media-content.test.ts` — đọc file đó trước, đừng bịa tên.

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/core/usecases/get-media-redirect.test.ts`
Expected: FAIL — `result.redirectUrl` là `undefined`.

- [ ] **Step 3: Sửa usecase**

Trong nhánh `if (asset.origin === "upload")` (quanh dòng 215), **trước** khi đọc byte:

```ts
    if (asset.origin === "upload" && asset.storageKey) {
      // Chữ ký HMAC đã được kiểm ở trên — chỉ sau đó mới được ký URL đọc.
      // TTL ngắn: URL này chính là bearer.
      const redirectUrl = await deps.blobs.createDownloadUrl({
        tenantId,
        storageKey: asset.storageKey,
        expiresInSeconds: MEDIA_REDIRECT_TTL_SECONDS,
      });
      if (redirectUrl) {
        log.debug("Serving an uploaded asset by redirect", {
          drive_file_id: assetId,
          // KHÔNG log redirectUrl — nó là bearer.
        });
        return { ...base, redirectUrl, bytes: new Uint8Array(0), mimeType: asset.mimeType };
      }
    }
```

Thêm hằng số cạnh các hằng khác đầu file:

```ts
/** TTL của URL đọc ký sẵn. Ngắn: chính nó là bearer. */
export const MEDIA_REDIRECT_TTL_SECONDS = 300;
```

Và thêm `readonly redirectUrl?: string | null;` vào interface kết quả.

- [ ] **Step 4: Sửa route**

Trong `src/app/api/media/[driveFileId]/route.ts`, ngay sau khi có `result`:

```ts
    if (result.redirectUrl) {
      // 302 chứ không phải 301: URL đích hết hạn sau vài phút, không được cache.
      return new Response(null, {
        status: 302,
        headers: { Location: result.redirectUrl, "Cache-Control": "no-store" },
      });
    }
```

- [ ] **Step 5: Chạy test**

Run: `pnpm vitest run src/core/usecases/`
Expected: PASS, kể cả `get-media-content.test.ts` cũ.

- [ ] **Step 6: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/usecases/get-media-content.ts src/core/usecases/get-media-redirect.test.ts "src/app/api/media/[driveFileId]/route.ts"
git commit -m "feat(media): redirect uploaded assets to a short-lived signed URL"
```

---

## Task 10: UI — tải thẳng lên MinIO

**Files:**
- Create: `src/ui/services/upload.api.ts`
- Create: `src/ui/hooks/useDirectUpload.ts`
- Test: `src/ui/hooks/direct-upload-queue.test.ts`
- Create: `src/ui/hooks/direct-upload-queue.ts`
- Modify: `src/ui/components/compose/UploadPanel.tsx`
- Modify: `src/ui/hooks/useComposeWizard.ts:195-215`

**Interfaces:**
- Consumes: route `tickets` (Task 6), route `confirm` (Task 7).
- Produces:
  ```ts
  // upload.api.ts
  requestUploadTickets(input: {productCode: string; files: {fileName: string; mimeType: string; sizeBytes: number}[]}, signal?): Promise<TicketsResponse>
  postFileToStorage(input: {postUrl: string; formFields: Record<string,string>; file: File}, signal?): Promise<void>
  confirmUpload(input: {productCode: string; assets: {assetId: string}[]; order?: number[]}, signal?): Promise<UploadResponse>
  // direct-upload-queue.ts (thuần, test không cần DOM)
  planUploadOrder(files: readonly File[]): {fileName: string; mimeType: string; sizeBytes: number}[]
  nextProgress(done: number, total: number): number
  ```
  `UploadResponse` giữ nguyên kiểu đang có trong `src/ui/schemas/compose.schema.ts` — shape trả về của `confirm` cố ý giống hệt route multipart cũ.

- [ ] **Step 1: Viết test thuần thất bại**

```ts
// src/ui/hooks/direct-upload-queue.test.ts
import { describe, expect, it } from "vitest";

import { nextProgress, planUploadOrder } from "@/ui/hooks/direct-upload-queue";

function fakeFile(name: string, size: number, type: string): File {
  return { name, size, type } as File;
}

describe("direct-upload-queue", () => {
  it("planUploadOrder giữ nguyên thứ tự và lấy đúng ba trường", () => {
    expect(planUploadOrder([fakeFile("b.png", 2, "image/png"), fakeFile("a.png", 1, "image/png")])).toEqual([
      { fileName: "b.png", mimeType: "image/png", sizeBytes: 2 },
      { fileName: "a.png", mimeType: "image/png", sizeBytes: 1 },
    ]);
  });

  it("planUploadOrder với danh sách rỗng trả rỗng", () => {
    expect(planUploadOrder([])).toEqual([]);
  });

  it("nextProgress kẹp trong 0..100 và không chia cho 0", () => {
    expect(nextProgress(0, 0)).toBe(0);
    expect(nextProgress(1, 4)).toBe(25);
    expect(nextProgress(9, 4)).toBe(100);
  });
});
```

- [ ] **Step 2: Chạy để chắc chắn nó fail**

Run: `pnpm vitest run src/ui/hooks/direct-upload-queue.test.ts`
Expected: FAIL — module không tồn tại.

- [ ] **Step 3: Viết module thuần**

```ts
// src/ui/hooks/direct-upload-queue.ts
/**
 * Phần thuần của đường tải thẳng: những quyết định phải test được mà không
 * cần DOM, không cần mạng. Mọi thứ chạm `fetch` nằm ở `upload.api.ts`.
 */

export interface UploadCandidate {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Lời khai gửi lên chặng xin vé. Thứ tự giữ nguyên: phần tử 0 là ảnh bìa. */
export function planUploadOrder(files: readonly File[]): UploadCandidate[] {
  return files.map((file) => ({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  }));
}

/** Phần trăm đã xong, kẹp trong 0..100. `total = 0` trả 0, không chia cho 0. */
export function nextProgress(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.round((done / total) * 100);
  return Math.min(100, Math.max(0, ratio));
}
```

- [ ] **Step 4: Chạy test**

Run: `pnpm vitest run src/ui/hooks/direct-upload-queue.test.ts`
Expected: PASS (3 test).

- [ ] **Step 5: Viết service**

```ts
// src/ui/services/upload.api.ts
import { httpClient } from "@/ui/services/http-client";
import type { UploadResponse } from "@/ui/schemas/compose.schema";

import type { UploadCandidate } from "@/ui/hooks/direct-upload-queue";

/**
 * Ba chặng của mode B. Chặng giữa là chặng DUY NHẤT byte rời máy, và nó
 * KHÔNG đi qua app server — POST thẳng vào MinIO bằng policy đã ký.
 */

export interface IssuedTicketDto {
  readonly assetId: string;
  readonly fileName: string;
  readonly postUrl: string;
  readonly formFields: Record<string, string>;
  readonly expiresAt: string;
}

export interface TicketsResponse {
  readonly issued: readonly IssuedTicketDto[];
  readonly rejected: readonly { fileName: string; reason: string; userMessage: string }[];
}

export function requestUploadTickets(
  input: { productCode: string; files: readonly UploadCandidate[] },
  signal?: AbortSignal,
): Promise<TicketsResponse> {
  return httpClient.post<TicketsResponse>("/api/posts/uploads/tickets", input, { signal });
}

/**
 * Không dùng `httpClient`: đích là MinIO, không phải API của mình — gửi kèm
 * header phiên tới một host khác là sai.
 */
export async function postFileToStorage(
  input: { postUrl: string; formFields: Record<string, string>; file: File },
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  // Thứ tự có ý nghĩa với S3/MinIO: mọi field policy phải đứng TRƯỚC `file`.
  for (const [key, value] of Object.entries(input.formFields)) form.append(key, value);
  form.append("file", input.file);

  const response = await fetch(input.postUrl, { method: "POST", body: form, signal });
  if (!response.ok) {
    throw new Error(`Tải "${input.file.name}" lên kho lưu trữ thất bại (${response.status}).`);
  }
}

export function confirmUpload(
  input: { productCode: string; assets: readonly { assetId: string }[]; order?: readonly number[] },
  signal?: AbortSignal,
): Promise<UploadResponse> {
  return httpClient.post<UploadResponse>("/api/posts/uploads/confirm", input, { signal });
}
```

Nếu `httpClient` không có method `post` với chữ ký này, mở `src/ui/services/http-client.ts` và theo đúng API nó cung cấp — `src/ui/services/post.api.ts` là mẫu.

- [ ] **Step 6: Viết hook**

```ts
// src/ui/hooks/useDirectUpload.ts
"use client";

import { useCallback, useRef, useState } from "react";

import { nextProgress, planUploadOrder } from "@/ui/hooks/direct-upload-queue";
import { confirmUpload, postFileToStorage, requestUploadTickets } from "@/ui/services/upload.api";
import type { UploadResponse } from "@/ui/schemas/compose.schema";

/** Bao nhiêu file POST cùng lúc. Ba là đủ nhanh mà không làm nghẽn mạng nhà. */
const CONCURRENCY = 3;

export interface DirectUploadState {
  readonly isUploading: boolean;
  readonly progress: number;
  readonly error: string | null;
}

export function useDirectUpload() {
  const [state, setState] = useState<DirectUploadState>({ isUploading: false, progress: 0, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ isUploading: false, progress: 0, error: null });
  }, []);

  const upload = useCallback(
    async (productCode: string, files: readonly File[]): Promise<UploadResponse> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ isUploading: true, progress: 0, error: null });

      try {
        const tickets = await requestUploadTickets(
          { productCode, files: planUploadOrder(files) },
          controller.signal,
        );

        const byName = new Map(files.map((file) => [file.name, file]));
        const jobs = tickets.issued
          .map((ticket) => ({ ticket, file: byName.get(ticket.fileName) }))
          .filter((job): job is { ticket: (typeof tickets.issued)[number]; file: File } => job.file !== undefined);

        let done = 0;
        // Hàng đợi thủ công thay vì Promise.all: giữ số POST đồng thời ở mức
        // CONCURRENCY, và một file lỗi phải dừng cả lô chứ không âm thầm
        // để lại một album thiếu ảnh.
        const queue = [...jobs];
        async function worker(): Promise<void> {
          for (;;) {
            const job = queue.shift();
            if (!job) return;
            await postFileToStorage(
              { postUrl: job.ticket.postUrl, formFields: job.ticket.formFields, file: job.file },
              controller.signal,
            );
            done += 1;
            setState((prev) => ({ ...prev, progress: nextProgress(done, jobs.length) }));
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

        const result = await confirmUpload(
          { productCode, assets: jobs.map((job) => ({ assetId: job.ticket.assetId })) },
          controller.signal,
        );

        setState({ isUploading: false, progress: 100, error: null });
        return result;
      } catch (error) {
        // Không nuốt: đưa câu tiếng Việt ra màn hình và ném tiếp cho caller.
        const message = error instanceof Error ? error.message : "Tải file lên thất bại.";
        setState({ isUploading: false, progress: 0, error: message });
        throw error;
      } finally {
        abortRef.current = null;
      }
    },
    [],
  );

  return { ...state, upload, cancel };
}
```

- [ ] **Step 7: Nối vào wizard**

Trong `src/ui/hooks/useComposeWizard.ts`, đổi `mutationFn` của `upload` (dòng ~197) từ `uploadMedia({...})` sang hook mới:

```ts
  const direct = useDirectUpload();
  const upload = useMutation<UploadResponse, ApiError, void>({
    mutationFn: () => {
      const values = form.getValues();
      return direct.upload(values.productCode, uploadQueue.map((item) => item.file));
    },
    // phần onSuccess / onError giữ nguyên
  });
```

Giữ nguyên mọi thứ khác trong khối đó — `uploadedCount`, `uploadRejections`, `upload.reset()` đều hoạt động vì `UploadResponse` không đổi shape.

- [ ] **Step 8: Hiện tiến độ trong UploadPanel**

Trong `src/ui/components/compose/UploadPanel.tsx`, thêm prop `progress: number` và vẽ `<Progress value={progress} />` (component đã có ở `src/ui/components/ui/progress.tsx`) khi `isUploading`. Kèm nhãn text cho người dùng trình đọc màn hình:

```tsx
      {props.isUploading ? (
        <div className="space-y-1" role="status" aria-live="polite">
          <Progress value={props.progress} />
          <p className="text-muted-foreground text-sm">Đang tải lên {props.progress}%.</p>
        </div>
      ) : null}
```

`aria-live="polite"` chỉ đọc khi nội dung đổi — không tự lặp lại, đúng bài học đã sửa ở commit `5a9b78a`.

- [ ] **Step 9: Chạy dev và xem thật**

```bash
docker compose up -d minio postgres redis
pnpm dev
```

Mở `http://localhost:3000/compose`, gõ một mã, kéo 3 ảnh, tải lên. Kiểm bằng mắt: thanh tiến độ chạy, 3 ảnh hiện trong album. Kiểm bằng DevTools → Network: có **1** request tới `/api/posts/uploads/tickets`, **3** request POST tới host MinIO, **1** request tới `/api/posts/uploads/confirm`, và **không** request nào mang byte ảnh tới `localhost:3000`.

- [ ] **Step 10: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/ui/services/upload.api.ts src/ui/hooks/useDirectUpload.ts src/ui/hooks/direct-upload-queue.ts src/ui/hooks/direct-upload-queue.test.ts src/ui/hooks/useComposeWizard.ts src/ui/components/compose/UploadPanel.tsx
git commit -m "feat(compose): upload files straight to object storage from the browser"
```

---

## Task 11: Compose, env, và di trú

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.prod.yml`, `.env.example`
- Modify: `src/composition/container.ts:777`
- Create: `scripts/migrate-uploads-to-minio.ts`

**Interfaces:**
- Consumes: `makeMinioBlobStore` (Task 3, 4), `loadMinioConfig` (Task 1).

- [ ] **Step 1: Thêm service MinIO vào `docker-compose.yml`**

```yaml
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}
      MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Thêm `miniodata:` vào khối `volumes:` ở cuối file. Thêm `minio` vào `depends_on` của `web` và `worker`.

- [ ] **Step 2: Tạo bucket lúc khởi động**

```yaml
  minio-init:
    image: minio/mc
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      sh -c "mc alias set local http://minio:9000 $$MINIO_ACCESS_KEY $$MINIO_SECRET_KEY &&
             mc mb -p local/$$MINIO_BUCKET &&
             mc anonymous set none local/$$MINIO_BUCKET"
    environment:
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      MINIO_BUCKET: ${MINIO_BUCKET:-mysp-media}
```

`mc anonymous set none` là dòng khiến bucket **private hoàn toàn** — chỉ URL ký sẵn mới đọc được. Bỏ dòng này là mở toàn bộ ảnh của mọi tenant ra internet.

- [ ] **Step 3: Thêm env vào `.env.example`**

```
# MinIO — hai endpoint, KHÔNG phải một. URL ký sẵn mang theo hostname trong
# chữ ký: URL đưa ra browser phải ký bằng host công khai, còn stat/copy/delete
# phía server đi bằng host nội bộ trong mạng Docker.
MINIO_INTERNAL_ENDPOINT=minio:9000
MINIO_PUBLIC_ENDPOINT=https://media.vannt.asia
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_BUCKET=mysp-media
MINIO_USE_SSL=true
```

- [ ] **Step 4: Đổi wiring**

`src/composition/container.ts:777`:

```ts
  const blobs = overrides.blobs ?? makeMinioBlobStore({ config: loadMinioConfig(), logger: deps.logger });
```

Xoá import `makeLocalBlobStore` và `loadUploadConfig` nếu không còn chỗ nào dùng — `UPLOAD_ORPHAN_TTL_HOURS` vẫn dùng cho sweep, nên kiểm trước khi xoá `loadUploadConfig`.

- [ ] **Step 5: Viết script di trú**

```ts
// scripts/migrate-uploads-to-minio.ts
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { makeMinioBlobStore } from "@/adapters/media/minio-blob-store";
import { loadMinioConfig, loadUploadConfig } from "@/composition/config";

/**
 * Chuyển file mode B từ volume `uploaddata` lên MinIO, GIỮ NGUYÊN storage_key.
 *
 * Không xoá gì ở nguồn: xoá volume là thao tác tay, sau khi PM xác nhận. Giữ
 * nguyên key nghĩa là cột `storage_key` không phải di trú giá trị nào, và quay
 * lui chỉ là revert commit đổi wiring.
 *
 * Chạy: pnpm tsx --env-file-if-exists=.env scripts/migrate-uploads-to-minio.ts
 */

async function main(): Promise<void> {
  const root = resolve(loadUploadConfig().UPLOAD_STORAGE_ROOT);
  const logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {}, child() { return this; } };
  const blobs = makeMinioBlobStore({ config: loadMinioConfig(), logger: logger as never });

  // Danh sách asset lấy từ DB để không copy file rác: chỉ những row thật.
  const rows = await listUploadRows();
  let moved = 0;
  let mismatched = 0;
  let missing = 0;

  for (const row of rows) {
    const [tenantSegment, assetId] = row.storageKey.split("/");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(root, tenantSegment, assetId)));
    } catch {
      missing += 1;
      console.error(`MISSING ${row.storageKey}`);
      continue;
    }

    const stored = await blobs.put({
      tenantId: row.tenantId,
      assetId,
      bytes,
      mimeType: row.mimeType ?? "application/octet-stream",
      kind: row.kind,
    });

    if (stored.sizeBytes !== bytes.length) {
      mismatched += 1;
      console.error(`SIZE MISMATCH ${row.storageKey}: ${stored.sizeBytes} != ${bytes.length}`);
      continue;
    }
    moved += 1;
  }

  console.log(`moved=${moved} missing=${missing} mismatched=${mismatched} total=${rows.length}`);
  if (missing > 0 || mismatched > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

`listUploadRows()` viết bằng drizzle: `select` từ `mediaAssets` với `eq(mediaAssets.origin, "upload")` và `isNotNull(mediaAssets.storageKey)`, trả `{ tenantId, storageKey, mimeType, kind }`. Đọc `src/adapters/db/media-repo.drizzle.ts` để dùng đúng cách dựng handle mà các script khác dùng.

- [ ] **Step 6: Chạy thử di trú trên dev**

```bash
docker compose up -d minio minio-init postgres
pnpm tsx --env-file-if-exists=.env scripts/migrate-uploads-to-minio.ts
```

Expected: dòng cuối in `moved=N missing=0 mismatched=0`. Nếu `missing > 0` thì **dừng** và báo PM — có row trỏ tới file không còn trên đĩa, đó là dữ liệu cần xem lại chứ không phải lỗi script.

- [ ] **Step 7: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml .env.example src/composition/container.ts scripts/migrate-uploads-to-minio.ts
git commit -m "feat(infra): run MinIO in compose and point the blob store at it"
```

---

## Task 12: Cổng cuối — đăng thật, rồi xoá local blob store

**Files:**
- Delete: `src/adapters/media/local-blob-store.ts` và test của nó
- Modify: `src/composition/config.ts` (bỏ `UPLOAD_STORAGE_ROOT` nếu không còn ai đọc)
- Modify: `docs/08-tien-do-du-an.md`

**Đây là commit CUỐI của epic.** Xoá adapter cũ nghĩa là không còn đường lui bằng env — chỉ được làm sau khi bước 1 dưới đây đã qua.

- [ ] **Step 1: Đăng một bài thật lên Facebook bằng ảnh vừa tải lên MinIO**

```bash
docker compose up -d
```

Vào `/compose`, chọn một mã còn hàng, tải 3 ảnh, sinh caption, chọn một kênh thật, đăng ngay.

Expected — kiểm **cả ba**:
1. Bài lên Facebook đủ 3 ảnh, đúng thứ tự, ảnh bìa đúng.
2. Log worker có dòng `Photo bytes will be uploaded for this attempt` — chứng minh worker đọc byte từ MinIO qua `readMediaBytes` chứ không đưa URL cho Graph.
3. `mc ls local/mysp-media/staging/` **rỗng** — không còn file chưa duyệt nào.

Nếu bất kỳ mục nào sai: **dừng, không xoá gì**, báo PM.

- [ ] **Step 2: Chạy trọn bộ case sai của spec mục 11**

```bash
cp /bin/ls /tmp/fake.jpg
```

Tải `/tmp/fake.jpg` qua màn compose. Expected: bị từ chối với câu "Nội dung file ... không khớp định dạng khai báo", và `mc ls local/mysp-media/media/` **không** có nó.

Tải một file 30MB. Expected: MinIO tự trả lỗi ở chặng POST, Node không nhận byte nào.

Để một vé quá 30 phút rồi bấm xác nhận. Expected: câu "Phiên tải ... đã hết hạn".

- [ ] **Step 3: Xoá adapter cũ**

```bash
git rm src/adapters/media/local-blob-store.ts src/adapters/media/local-blob-store.extended.test.ts
grep -rn "makeLocalBlobStore\|UPLOAD_STORAGE_ROOT" src/ scripts/
```

Sửa mọi chỗ còn tham chiếu. `scripts/migrate-uploads-to-minio.ts` đọc `UPLOAD_STORAGE_ROOT` — giữ script và giữ khoá config đó, vì nó là đường di trú cho VPS chưa chuyển.

- [ ] **Step 4: `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0. Nếu typecheck đỏ vì một fixture còn implement port kiểu cũ, sửa fixture.

- [ ] **Step 5: Cập nhật tiến độ**

Trong `docs/08-tien-do-du-an.md`, thêm một dòng dưới mục 3.1 (E9): MinIO + presigned upload đã xong, kèm ngày và số hiệu commit cuối. Ghi rõ ba con số đo được ở Step 1 (số ảnh, staging rỗng, worker đọc byte).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(media): drop the local blob store now that MinIO serves every upload"
```

---

## Self-Review

**Spec coverage** — đối chiếu từng mục của spec:

| Mục spec | Task |
|---|---|
| 2.1 adapter MinIO thay local | 3, 4, 11 |
| 2.2 mở rộng port | 2 |
| 2.3 upload hai chặng | 6, 7, 10 |
| 2.4 đảo thứ tự kiểm duyệt + vùng staging | 4 (`promote`), 7 (thứ tự sniff → promote) |
| 2.5 media bridge 302 | 9 |
| 2.6 service minio trong Compose | 11 |
| 2.7 script di trú | 11 |
| 2.8 sweep vé quá hạn | 8 |
| 6.4 bảng `upload_ticket` | 5 |
| 8 hai client nội bộ/công khai | 3 (`clientFor`), 4 (`createUploadUrl` dùng client công khai) |
| 10 quy ước `reason` thay vì mã lỗi mới | Global Constraints + 6, 7, 8 |
| 11 test tích hợp 1–7 | 3, 4, 5, 10 (Step 9), 12 (Step 1–2) |
| 12 rủi ro 1 (ký sai host) | 4 Step 1 test ký bằng client công khai; 12 Step 1 chạy thật qua tunnel |
| 12 rủi ro 4 (`minio` với Next 16) | 1 Step 1, dừng lại nếu hỏng |

Không có mục nào của spec thiếu task.

**Placeholder scan:** không có "TBD"/"TODO"/"tương tự Task N". Ba chỗ cố ý bảo người làm tự đọc file trước khi đặt tên — `DbHandle` (Task 5), `ctx.userId` (Task 6), `depsForUploadAsset` (Task 9) — đều nêu rõ file phải mở và lý do, chứ không phải chỗ trống.

**Type consistency:** `storageKey` là `<tenant>/<asset>` ở mọi task. `createUploadUrl` trả `{postUrl, formFields, storageKey, expiresAt}` ở Task 2, 4, 6, 10 — thống nhất. `UploadRejectionReport` dùng lại từ `upload-media.ts` ở Task 6 và 7. `assertOneAlbumKind` đổi chữ ký một lần ở Task 6 Step 3, và Task 7 dùng đúng chữ ký mới.

**Một mâu thuẫn đã sửa khi soát:** Task 7 gọi `blobs.stat()` (nhắm vùng phục vụ) cho object còn ở staging — luôn trả `null`. Đã thêm `statStaging()` đi qua `readRange` để kiểm sự tồn tại, còn kích thước thật lấy từ `promote()`. Nếu người làm thấy cách này lòng vòng thì phương án sạch hơn là thêm `statStaging` vào port; **hỏi trước khi đổi port**, đừng tự mở rộng.
