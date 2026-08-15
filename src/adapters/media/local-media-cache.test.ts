import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeLocalMediaCache } from "@/adapters/media/local-media-cache";
import type { Logger } from "@/core/ports/infra";
import type { MediaByteCache } from "@/core/ports/media-byte-cache";

/**
 * The cache stands between Meta's fetcher and Drive, so the tests lead with the
 * ways it must NOT behave: serving another tenant's file, following a traversal,
 * serving an entry past its TTL, or blowing the caller's memory budget.
 */

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";
const ASSET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs";
const HOUR = 60 * 60 * 1000;
const TTL_MS = 72 * HOUR;

function makeLogger(): Logger & { lines: Array<{ message: string; context?: unknown }> } {
  const lines: Array<{ message: string; context?: unknown }> = [];
  const record = (message: string, context?: unknown) => {
    lines.push({ message, context });
  };
  const logger = {
    lines,
    child: () => logger,
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as Logger & { lines: typeof lines };
  return logger;
}

let root: string;
let cache: MediaByteCache;
let logger: ReturnType<typeof makeLogger>;
let nowMs: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mysp-media-cache-"));
  logger = makeLogger();
  nowMs = Date.UTC(2026, 7, 15, 9, 0, 0);
  cache = makeLocalMediaCache({ root, ttlMs: TTL_MS, logger, now: () => nowMs });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Backdates an entry so the TTL/sweep sees it as old, without sleeping. */
async function ageEntry(tenantId: string, assetId: string, ageMs: number): Promise<void> {
  const when = new Date(nowMs - ageMs);
  await utimes(join(root, tenantId, assetId), when, when);
}

describe("localMediaCache — misses come first", () => {
  it("returns null for an asset that was never cached", async () => {
    expect(await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 })).toBeNull();
  });

  it("returns null when the root directory does not exist at all", async () => {
    const missing = makeLocalMediaCache({
      root: join(root, "never-created"),
      ttlMs: TTL_MS,
      logger,
      now: () => nowMs,
    });
    expect(await missing.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 })).toBeNull();
    expect(await missing.evictOlderThan({ olderThan: new Date(nowMs) })).toEqual({
      scanned: 0,
      removed: 0,
      failed: 0,
    });
  });

  it("treats an entry past its TTL as a miss and leaves it to the sweep", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("old"), mimeType: null });
    await ageEntry(TENANT_A, ASSET, TTL_MS + HOUR);

    expect(await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 })).toBeNull();
    // Still on disk: expiry is a read decision, deletion is the sweep's job.
    await expect(stat(join(root, TENANT_A, ASSET))).resolves.toBeTruthy();
  });

  it("still serves an entry that is one hour short of the TTL", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("fresh"), mimeType: null });
    await ageEntry(TENANT_A, ASSET, TTL_MS - HOUR);

    const hit = await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 });
    expect(hit).not.toBeNull();
    expect(new TextDecoder().decode(hit!.bytes)).toBe("fresh");
  });

  it("misses instead of buffering an entry larger than maxBytes", async () => {
    await cache.put({
      tenantId: TENANT_A,
      assetId: ASSET,
      bytes: bytes("0123456789"),
      mimeType: "image/jpeg",
    });

    // A miss, NOT a throw: the origin still has the bytes, and it is the
    // caller's own size check that must reject an oversized asset.
    expect(await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 5 })).toBeNull();
  });

  it("refuses a caller with no byte budget rather than serving unbounded bytes", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("x"), mimeType: null });

    for (const maxBytes of [0, -1, Number.NaN]) {
      await expect(
        cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("misses on a corrupt entry and says so in the log instead of throwing", async () => {
    await mkdir(join(root, TENANT_A), { recursive: true });
    await writeFile(join(root, TENANT_A, ASSET), "not a cache entry at all");

    expect(await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 })).toBeNull();
    expect(logger.lines.some((line) => line.message.includes("unreadable media cache entry"))).toBe(
      true,
    );
  });

  it("refuses to write an empty body", async () => {
    await expect(
      cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: new Uint8Array(), mimeType: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("localMediaCache — tenant isolation and traversal", () => {
  it("does not serve one tenant's entry to another", async () => {
    await cache.put({
      tenantId: TENANT_A,
      assetId: ASSET,
      bytes: bytes("private"),
      mimeType: "image/jpeg",
    });

    expect(await cache.get({ tenantId: TENANT_B, assetId: ASSET, maxBytes: 1024 })).toBeNull();
  });

  it("misses on any id that is not one safe path segment", async () => {
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "loot.txt"), "loot");

    for (const assetId of [
      "../elsewhere/loot.txt",
      "../../etc/passwd",
      "/etc/passwd",
      "sub/dir",
      "..",
      "",
      "   ",
      "with space",
    ]) {
      expect(await cache.get({ tenantId: TENANT_A, assetId, maxBytes: 1024 })).toBeNull();
    }
    for (const tenantId of ["..", "a/b", "", "../elsewhere"]) {
      expect(await cache.get({ tenantId, assetId: ASSET, maxBytes: 1024 })).toBeNull();
    }

    // The decoy is untouched: nothing was read, nothing was moved.
    expect(await readFile(join(root, "elsewhere", "loot.txt"), "utf8")).toBe("loot");
  });

  it("refuses to WRITE under an unsafe id instead of sanitising it", async () => {
    for (const assetId of ["../escape", "a/b", "", "..", "with space"]) {
      await expect(
        cache.put({ tenantId: TENANT_A, assetId, bytes: bytes("x"), mimeType: null }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      cache.put({ tenantId: "../escape", assetId: ASSET, bytes: bytes("x"), mimeType: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("localMediaCache — round trip", () => {
  it("stores bytes with their mime type and reads both back", async () => {
    const payload = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    await cache.put({
      tenantId: TENANT_A,
      assetId: ASSET,
      bytes: payload,
      mimeType: "image/png",
    });

    const hit = await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 });
    expect(hit).toEqual({ bytes: payload, mimeType: "image/png" });
  });

  it("keeps a null mime type null — the 606 extension-less files have none", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("x"), mimeType: null });
    expect((await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 }))?.mimeType).toBe(
      null,
    );
  });

  it("overwrites a previous entry and leaves no temp file behind", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("one"), mimeType: null });
    await cache.put({
      tenantId: TENANT_A,
      assetId: ASSET,
      bytes: bytes("two-longer"),
      mimeType: "image/jpeg",
    });

    const hit = await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 });
    expect(new TextDecoder().decode(hit!.bytes)).toBe("two-longer");
    expect(await readdir(join(root, TENANT_A))).toEqual([ASSET]);
  });

  it("keeps binary content byte-identical, newlines included", async () => {
    // The entry format is `header\n<bytes>`, so bytes containing 0x0A are the
    // case that would break a naive reader.
    const payload = new Uint8Array([0x0a, 0x00, 0x0a, 0x7b, 0x0a]);
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: payload, mimeType: "image/jpeg" });

    const hit = await cache.get({ tenantId: TENANT_A, assetId: ASSET, maxBytes: 1024 });
    expect(hit!.bytes).toEqual(payload);
  });
});

describe("localMediaCache — sweep", () => {
  it("removes only entries older than the cutoff, across tenants", async () => {
    await cache.put({ tenantId: TENANT_A, assetId: ASSET, bytes: bytes("old"), mimeType: null });
    await cache.put({ tenantId: TENANT_A, assetId: "keep_me", bytes: bytes("new"), mimeType: null });
    await cache.put({ tenantId: TENANT_B, assetId: ASSET, bytes: bytes("old-b"), mimeType: null });
    await ageEntry(TENANT_A, ASSET, 100 * HOUR);
    await ageEntry(TENANT_B, ASSET, 100 * HOUR);

    const result = await cache.evictOlderThan({ olderThan: new Date(nowMs - TTL_MS) });

    expect(result).toMatchObject({ scanned: 3, removed: 2, failed: 0 });
    expect(await cache.get({ tenantId: TENANT_A, assetId: "keep_me", maxBytes: 1024 })).not.toBeNull();
    await expect(stat(join(root, TENANT_A, ASSET))).rejects.toThrow();
    await expect(stat(join(root, TENANT_B, ASSET))).rejects.toThrow();
  });

  it("removes a stale temp file some crashed write left behind", async () => {
    await mkdir(join(root, TENANT_A), { recursive: true });
    const orphan = join(root, TENANT_A, `${ASSET}.999.abc.part`);
    await writeFile(orphan, "half written");
    const old = new Date(nowMs - 100 * HOUR);
    await utimes(orphan, old, old);

    const result = await cache.evictOlderThan({ olderThan: new Date(nowMs - TTL_MS) });

    expect(result.removed).toBe(1);
    await expect(stat(orphan)).rejects.toThrow();
  });

  it("caps REMOVALS, not inspections, so an expired tail is always reachable", async () => {
    for (const assetId of ["a_one", "a_two", "a_three"]) {
      await cache.put({ tenantId: TENANT_A, assetId, bytes: bytes(assetId), mimeType: null });
      await ageEntry(TENANT_A, assetId, 100 * HOUR);
    }

    const first = await cache.evictOlderThan({ olderThan: new Date(nowMs - TTL_MS), limit: 2 });
    expect(first.removed).toBe(2);

    const second = await cache.evictOlderThan({ olderThan: new Date(nowMs - TTL_MS), limit: 2 });
    expect(second.removed).toBe(1);
    expect(await readdir(join(root, TENANT_A))).toEqual([]);
  });

  it("rejects an invalid cutoff instead of deleting on a NaN comparison", async () => {
    await expect(
      cache.evictOlderThan({ olderThan: new Date("nonsense") }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("localMediaCache — construction", () => {
  it("refuses a cache with no usable TTL", () => {
    for (const ttlMs of [0, -1, Number.NaN]) {
      expect(() => makeLocalMediaCache({ root, ttlMs, logger })).toThrowError();
    }
  });
});
