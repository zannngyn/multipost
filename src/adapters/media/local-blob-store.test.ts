import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeLocalBlobStore } from "@/adapters/media/local-blob-store";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

let root: string;
let store: MediaBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mysp-blob-"));
  store = makeLocalBlobStore({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("localBlobStore — round trip", () => {
  it("stores bytes and reads them back", async () => {
    const stored = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_abc123",
      bytes: bytes("hello"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    expect(stored.sizeBytes).toBe(5);

    const content = await store.get({
      tenantId: TENANT_A,
      storageKey: stored.storageKey,
      maxBytes: 1024,
    });
    expect(content).not.toBeNull();
    expect(new TextDecoder().decode(content!.bytes)).toBe("hello");
  });

  it("overwrites cleanly when the same asset is stored twice", async () => {
    const first = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_abc123",
      bytes: bytes("one"),
      mimeType: "image/jpeg",
      kind: "image",
    });
    const second = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_abc123",
      bytes: bytes("two-longer"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    expect(second.storageKey).toBe(first.storageKey);
    const content = await store.get({
      tenantId: TENANT_A,
      storageKey: second.storageKey,
      maxBytes: 1024,
    });
    expect(new TextDecoder().decode(content!.bytes)).toBe("two-longer");
  });
});

describe("localBlobStore — edge cases", () => {
  it("returns null for a key that was never written", async () => {
    const content = await store.get({
      tenantId: TENANT_A,
      storageKey: `${TENANT_A}/upload_missing`,
      maxBytes: 1024,
    });
    expect(content).toBeNull();
  });

  it("refuses a blob bigger than maxBytes instead of buffering it", async () => {
    const stored = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_big",
      bytes: bytes("0123456789"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    await expect(
      store.get({ tenantId: TENANT_A, storageKey: stored.storageKey, maxBytes: 5 }),
    ).rejects.toThrow();
  });

  it("rejects an asset id that is not a safe file name", async () => {
    for (const assetId of ["../escape", "a/b", "", "   ", "..", "with space"]) {
      await expect(
        store.put({
          tenantId: TENANT_A,
          assetId,
          bytes: bytes("x"),
          mimeType: "image/jpeg",
          kind: "image",
        }),
      ).rejects.toThrow();
    }
  });
});

describe("localBlobStore — tenant isolation", () => {
  it("does not serve one tenant's blob to another", async () => {
    const stored = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_secret",
      bytes: bytes("private"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    // Tenant B presents tenant A's key verbatim.
    const content = await store.get({
      tenantId: TENANT_B,
      storageKey: stored.storageKey,
      maxBytes: 1024,
    });
    expect(content).toBeNull();
  });

  it("refuses a key that climbs out of the tenant's own area", async () => {
    // A real file placed outside the tenant folder, then targeted by traversal.
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "loot.txt"), "loot");

    for (const storageKey of [
      `${TENANT_A}/../elsewhere/loot.txt`,
      `${TENANT_A}/../../etc/passwd`,
      "/etc/passwd",
      `${TENANT_A}/sub/dir`,
    ]) {
      const content = await store.get({ tenantId: TENANT_A, storageKey, maxBytes: 1024 });
      expect(content).toBeNull();
    }

    // And the decoy is still where it was — nothing was read or moved.
    expect(await readFile(join(root, "elsewhere", "loot.txt"), "utf8")).toBe("loot");
  });
});

describe("localBlobStore — delete", () => {
  it("removes a blob once and reports the second call as a no-op", async () => {
    const stored = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_gone",
      bytes: bytes("bye"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    expect(await store.delete({ tenantId: TENANT_A, storageKey: stored.storageKey })).toBe(true);
    expect(await store.delete({ tenantId: TENANT_A, storageKey: stored.storageKey })).toBe(false);
    expect(
      await store.get({ tenantId: TENANT_A, storageKey: stored.storageKey, maxBytes: 1024 }),
    ).toBeNull();
  });

  it("will not delete across a tenant boundary", async () => {
    const stored = await store.put({
      tenantId: TENANT_A,
      assetId: "upload_keep",
      bytes: bytes("keep"),
      mimeType: "image/jpeg",
      kind: "image",
    });

    expect(await store.delete({ tenantId: TENANT_B, storageKey: stored.storageKey })).toBe(false);
    expect(
      await store.get({ tenantId: TENANT_A, storageKey: stored.storageKey, maxBytes: 1024 }),
    ).not.toBeNull();
  });
});
