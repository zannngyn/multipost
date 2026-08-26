import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeLocalBlobStore } from "@/adapters/media/local-blob-store";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

const TENANT = testTenantId("11111111-1111-4111-8111-111111111111");
let root = "";
let store: MediaBlobStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blob-"));
  store = makeLocalBlobStore({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local blob store — the extended surface", () => {
  it("stat returns the real size, null when the object is absent", async () => {
    await store.put({
      tenantId: TENANT,
      assetId: "a1",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      kind: "image",
    });
    expect(await store.stat({ tenantId: TENANT, storageKey: `${TENANT}/a1` })).toMatchObject({
      sizeBytes: 3,
    });
    expect(await store.stat({ tenantId: TENANT, storageKey: `${TENANT}/nope` })).toBeNull();
  });

  it("readRange reads only the first n bytes", async () => {
    await store.put({
      tenantId: TENANT,
      assetId: "a2",
      bytes: new Uint8Array([9, 8, 7, 6, 5]),
      mimeType: "image/png",
      kind: "image",
    });
    const head = await store.readRange({ tenantId: TENANT, storageKey: `${TENANT}/a2`, length: 2 });
    expect(head).toEqual(new Uint8Array([9, 8]));
  });

  it("statStaging matches stat — the local store has no separate staging area", async () => {
    expect(await store.statStaging({ tenantId: TENANT, storageKey: `${TENANT}/a1` })).toMatchObject({
      sizeBytes: 3,
    });
    expect(await store.statStaging({ tenantId: TENANT, storageKey: `${TENANT}/nope` })).toBeNull();
  });

  it("createDownloadUrl returns null — the local store cannot sign", async () => {
    expect(
      await store.createDownloadUrl({ tenantId: TENANT, storageKey: `${TENANT}/a1`, expiresInSeconds: 300 }),
    ).toBeNull();
  });

  it("createUploadUrl throws with an explicit reason", async () => {
    await expect(
      store.createUploadUrl({
        tenantId: TENANT,
        assetId: "a3",
        declaredMimeType: "image/png",
        maxBytes: 10,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ context: { reason: "PRESIGN_UNSUPPORTED" } });
  });
});
