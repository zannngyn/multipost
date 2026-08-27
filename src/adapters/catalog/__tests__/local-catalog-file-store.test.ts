import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";

import { makeLocalCatalogFileStore } from "../local-catalog-file-store";

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000a1");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-0000000000a2");
const encoder = new TextEncoder();

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mysp-catalog-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = () => makeLocalCatalogFileStore({ root });

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("makeLocalCatalogFileStore — refusals", () => {
  it("refuses to store an empty file", async () => {
    await expect(
      store().put({ tenantId: TENANT, fileName: "a.csv", bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "EMPTY_CATALOG_FILE" } });
  });

  it("refuses a tenant id that is not a safe path segment", async () => {
    await expect(
      store().put({
        tenantId: "../../etc" as unknown as typeof TENANT,
        fileName: "a.csv",
        bytes: encoder.encode("x"),
      }),
    ).rejects.toMatchObject({ context: { reason: "UNSAFE_PATH_SEGMENT" } });
  });

  it("answers null for a key that belongs to another tenant", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("Mã,Tên\nA,B\n"),
    });

    const leaked = await store().get({
      tenantId: OTHER_TENANT,
      storageKey: stored.storageKey,
      maxBytes: 1024,
    });

    // Null, not an error: "not yours" and "not there" must look identical.
    expect(leaked).toBeNull();
  });

  it.each([
    ["traversal", "../../../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["too many segments", "a/b/c"],
    ["single segment", "catalog_abc"],
  ])("answers null for a %s key", async (_label, storageKey) => {
    expect(await store().get({ tenantId: TENANT, storageKey, maxBytes: 1024 })).toBeNull();
  });

  it("answers null for a file that was never written", async () => {
    expect(
      await store().get({ tenantId: TENANT, storageKey: `${TENANT}/catalog_nope`, maxBytes: 1024 }),
    ).toBeNull();
  });

  it("refuses to read a file bigger than the caller's cap, before reading it", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "big.csv",
      bytes: encoder.encode("x".repeat(500)),
    });

    await expect(
      store().get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 100 }),
    ).rejects.toMatchObject({ context: { reason: "CATALOG_FILE_TOO_LARGE" } });
  });

  it("rejects a non-positive byte cap instead of reading anything", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("x"),
    });

    await expect(
      store().get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 0 }),
    ).rejects.toMatchObject({ context: { reason: "INVALID_MAX_BYTES" } });
  });
});

describe("makeLocalCatalogFileStore — storing and reading", () => {
  it("round-trips the exact bytes, BOM and CRLF included", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("Mã;Tên\r\nA;B\r\n")]);
    const stored = await store().put({ tenantId: TENANT, fileName: "bảng giá.csv", bytes });

    const read = await store().get({
      tenantId: TENANT,
      storageKey: stored.storageKey,
      maxBytes: 1024,
    });

    expect(read?.bytes).toEqual(bytes);
    expect(read?.sizeBytes).toBe(bytes.length);
    expect(stored.sizeBytes).toBe(bytes.length);
  });

  it("puts the tenant first in the key and never the original file name", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "../../evil name.csv",
      bytes: encoder.encode("x"),
    });

    expect(stored.storageKey.startsWith(`${TENANT}/`)).toBe(true);
    expect(stored.storageKey).not.toContain("evil");
    expect(stored.storageKey).toMatch(/^[0-9a-f-]+\/catalog_[0-9a-f]{24}$/);
  });

  it("keeps the previous upload readable until the config moves to the new one", async () => {
    const first = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("cũ"),
    });
    const second = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("mới"),
    });

    expect(second.storageKey).not.toBe(first.storageKey);
    const old = await store().get({ tenantId: TENANT, storageKey: first.storageKey, maxBytes: 99 });
    expect(new TextDecoder().decode(old?.bytes)).toBe("cũ");
  });

  it("leaves no partial file behind after a write", async () => {
    await store().put({ tenantId: TENANT, fileName: "a.csv", bytes: encoder.encode("x") });

    const entries = await readdir(join(root, TENANT));
    expect(entries.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("deletes a file it stored, and reports nothing to delete otherwise", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("x"),
    });

    expect(await store().delete({ tenantId: TENANT, storageKey: stored.storageKey })).toBe(true);
    expect(await store().delete({ tenantId: TENANT, storageKey: stored.storageKey })).toBe(false);
    expect(await store().get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 99 })).toBeNull();
  });

  it("refuses to delete another tenant's file", async () => {
    const stored = await store().put({
      tenantId: TENANT,
      fileName: "a.csv",
      bytes: encoder.encode("x"),
    });

    expect(await store().delete({ tenantId: OTHER_TENANT, storageKey: stored.storageKey })).toBe(
      false,
    );
    expect(
      await store().get({ tenantId: TENANT, storageKey: stored.storageKey, maxBytes: 99 }),
    ).not.toBeNull();
  });

  it("answers null when the key points at a directory, not a file", async () => {
    await store().put({ tenantId: TENANT, fileName: "a.csv", bytes: encoder.encode("x") });
    // A directory sitting where a file id would be.
    const dirKey = `${TENANT}/catalog_directory`;
    await writeFile(join(root, TENANT, "placeholder"), "x");
    await rm(join(root, TENANT, "placeholder"));

    expect(await store().get({ tenantId: TENANT, storageKey: dirKey, maxBytes: 99 })).toBeNull();
  });
});
