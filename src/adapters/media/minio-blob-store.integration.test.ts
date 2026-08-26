import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { makeMinioBlobStore } from "@/adapters/media/minio-blob-store";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

/**
 * Runs against a real MinIO:
 *   docker run -d --name minio-task34 -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
 *   docker run --rm --network host --entrypoint sh minio/mc -c "mc alias set t http://localhost:9000 minioadmin minioadmin && mc mb -p t/mysp-media-test"
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
  it("stores and reads back the exact bytes", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const stored = await store.put({ tenantId: TENANT, assetId: "p1", bytes, mimeType: "image/png", kind: "image" });
    expect(stored.storageKey).toBe(`${TENANT}/p1`);
    expect(stored.sizeBytes).toBe(4);

    const got = await store.get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 1024 });
    expect(got?.bytes).toEqual(bytes);
  });

  it("get returns null for an unknown key", async () => {
    expect(await store.get({ tenantId: TENANT, storageKey: `${TENANT}/khong-co`, maxBytes: 1024 })).toBeNull();
  });

  it("get refuses an object above maxBytes without pulling the bytes", async () => {
    await store.put({ tenantId: TENANT, assetId: "p2", bytes: new Uint8Array(1024), mimeType: "image/png", kind: "image" });
    await expect(store.get({ tenantId: TENANT, storageKey: `${TENANT}/p2`, maxBytes: 10 }))
      .rejects.toMatchObject({ context: { reason: "BLOB_TOO_LARGE" } });
  });

  it("refuses a key belonging to another tenant", async () => {
    const other = randomUUID();
    expect(await store.get({ tenantId: TENANT, storageKey: `${other}/p1`, maxBytes: 1024 })).toBeNull();
  });

  it("delete returns true, then false", async () => {
    expect(await store.delete({ tenantId: TENANT, storageKey: `${TENANT}/p1` })).toBe(true);
    expect(await store.delete({ tenantId: TENANT, storageKey: `${TENANT}/p1` })).toBe(false);
  });
});

describe.skipIf(!endpoint)("MinioBlobStore — presign and promote", () => {
  it("the POST policy accepts a file in range and refuses an oversized one", async () => {
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

  it("statStaging sees the staged object while stat does not", async () => {
    expect(await store.statStaging({ tenantId: TENANT, storageKey: `${TENANT}/u1` })).toMatchObject({ sizeBytes: 4 });
    expect(await store.stat({ tenantId: TENANT, storageKey: `${TENANT}/u1` })).toBeNull();
  });

  it("readRange reads the first four bytes of the staged object", async () => {
    const head = await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/u1`, length: 4 });
    expect(head).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("promote moves staging into the serving prefix and removes the staged copy", async () => {
    const promoted = await store.promote({ tenantId: TENANT, assetId: "u1" });
    expect(promoted.storageKey).toBe(`${TENANT}/u1`);
    expect(promoted.sizeBytes).toBe(4);
    expect(await store.get({ tenantId: TENANT, storageKey: `${TENANT}/u1`, maxBytes: 1024 })).not.toBeNull();
    expect(await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/u1`, length: 4 })).toBeNull();
  });

  it("promote throws UPLOAD_OBJECT_MISSING when nothing is staged", async () => {
    await expect(store.promote({ tenantId: TENANT, assetId: "khongco" }))
      .rejects.toMatchObject({ context: { reason: "UPLOAD_OBJECT_MISSING" } });
  });

  it("createDownloadUrl signs a URL that actually fetches", async () => {
    const url = await store.createDownloadUrl({ tenantId: TENANT, storageKey: `${TENANT}/u1`, expiresInSeconds: 60 });
    expect(url).toBeTruthy();
    expect((await fetch(url as string)).ok).toBe(true);
  });
});
