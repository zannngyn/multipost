import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Product } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";

import { makeDbHandle } from "../client";
import { DrizzleProductRepo } from "../product-repo.drizzle";
import { products, tenants } from "../schema";

/**
 * The SQL half of the manual product (onboarding phase 3). Three things can
 * only be proven against a real Postgres, and all three are load-bearing:
 *
 *   1. a manual row survives a sync — `deleteStale` is scoped to
 *      `origin = 'sheet'`, and `ne(NULL, x)` in SQL is NULL, not true;
 *   2. `saveManual` REFUSES to overwrite a synced row (`ON CONFLICT DO UPDATE
 *      ... WHERE origin = 'manual'` returns no row) — the race where a sync
 *      claims the code while the operator is composing;
 *   3. a sync that DOES describe the code takes the row back over.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/product-repo.manual.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

function manual(code: string, stockRaw: string): Product {
  return {
    content: { code, name: "Váy nhập tay", description: null, category: null, season: null },
    operational: { stockRaw, noteRaw: "", colorsRaw: "" },
    hasConflict: false,
    sourceRows: [],
    origin: "manual",
  };
}

function synced(code: string, stockRaw: string): Product {
  return {
    content: { code, name: "Váy đồng bộ", description: null, category: null, season: null },
    operational: { stockRaw, noteRaw: "", colorsRaw: "" },
    hasConflict: false,
    sourceRows: [2],
  };
}

describe.skipIf(!url)("DrizzleProductRepo — manual products", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleProductRepo(handle.db);
  const tenantId = testTenantId(randomUUID());

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E3 manual product test ${tenantId}`, status: "active" });
  });

  afterAll(async () => {
    await handle.db.delete(products).where(eq(products.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("stores a typed product with no sync run id and reads it back as manual", async () => {
    expect(await repo.saveManual(tenantId, manual("MAN-0001", "12"))).toBe("saved");

    const found = await repo.findByCode(tenantId, "MAN-0001");
    expect(found).toMatchObject({
      origin: "manual",
      content: { code: "MAN-0001", name: "Váy nhập tay" },
      operational: { stockRaw: "12" },
    });

    const [row] = await handle.db.select().from(products).where(eq(products.code, "MAN-0001"));
    expect(row?.lastSyncRunId).toBeNull();
  });

  it("updates its own row on a second compose", async () => {
    expect(await repo.saveManual(tenantId, manual("MAN-0002", "5"))).toBe("saved");
    expect(await repo.saveManual(tenantId, manual("MAN-0002", "0"))).toBe("saved");

    const found = await repo.findByCode(tenantId, "MAN-0002");
    expect(found?.operational.stockRaw).toBe("0");
  });

  it("survives a sync that does not mention it", async () => {
    const runId = randomUUID();
    await repo.saveManual(tenantId, manual("MAN-0003", "9"));
    await repo.upsertMany(tenantId, [synced("SYN-0003", "40")], runId);

    // A second sync sweeps the first one's rows; the manual row must stay.
    const nextRun = randomUUID();
    await repo.upsertMany(tenantId, [synced("SYN-0003", "41")], nextRun);
    const deleted = await repo.deleteStale(tenantId, nextRun);

    expect(deleted).toBe(0);
    expect(await repo.findByCode(tenantId, "MAN-0003")).toMatchObject({ origin: "manual" });
    expect(await repo.findByCode(tenantId, "SYN-0003")).toMatchObject({ origin: "sheet" });
  });

  it("deletes the synced rows a sync stopped describing, manual rows untouched", async () => {
    const runId = randomUUID();
    await repo.upsertMany(tenantId, [synced("SYN-0004", "10"), synced("SYN-0005", "10")], runId);
    await repo.saveManual(tenantId, manual("MAN-0004", "3"));

    const nextRun = randomUUID();
    await repo.upsertMany(tenantId, [synced("SYN-0004", "11")], nextRun);
    const deleted = await repo.deleteStale(tenantId, nextRun);

    // Named rows, not a global count: the cases share one tenant, so earlier
    // synced rows are legitimately swept by this run too.
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await repo.findByCode(tenantId, "SYN-0005")).toBeNull();
    expect(await repo.findByCode(tenantId, "SYN-0004")).not.toBeNull();
    expect(await repo.findByCode(tenantId, "MAN-0003")).not.toBeNull();
    expect(await repo.findByCode(tenantId, "MAN-0004")).not.toBeNull();
  });

  it("refuses to overwrite a code the synced catalog owns", async () => {
    await repo.upsertMany(tenantId, [synced("SYN-0006", "0")], randomUUID());

    expect(await repo.saveManual(tenantId, manual("SYN-0006", "999"))).toBe("refused_synced");

    // The synced values — including the stock that blocks — are intact.
    expect(await repo.findByCode(tenantId, "SYN-0006")).toMatchObject({
      origin: "sheet",
      content: { name: "Váy đồng bộ" },
      operational: { stockRaw: "0" },
    });
  });

  it("hands a manual code back to the catalog once a sync describes it", async () => {
    await repo.saveManual(tenantId, manual("MAN-0007", "7"));
    const runId = randomUUID();
    await repo.upsertMany(tenantId, [synced("MAN-0007", "40")], runId);

    expect(await repo.findByCode(tenantId, "MAN-0007")).toMatchObject({
      origin: "sheet",
      operational: { stockRaw: "40" },
    });

    // And from now on it is sweepable like any other synced row.
    expect(await repo.deleteStale(tenantId, randomUUID())).toBeGreaterThan(0);
    expect(await repo.findByCode(tenantId, "MAN-0007")).toBeNull();
  });
});
