import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDbHandle } from "./client";
import { findPgError } from "./db-errors";
import { DrizzlePostJobRepo } from "./post-job-repo.drizzle";
import { postBatches, tenants } from "./schema";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * `post_batch.spacing_ms` against a REAL Postgres — the per-run spacing gap.
 *
 * A stubbed query builder cannot prove any of what matters here:
 *  - a batch written WITHOUT the column (every batch created before the
 *    migration) reads back NULL, i.e. "use the tenant setting", which is the
 *    whole backwards-compatibility contract of this feature;
 *  - 0 round-trips as 0 and not as NULL — an operator who asked for no gap must
 *    not silently get the tenant's minute back;
 *  - the CHECK constraint is the last word for a writer that bypasses zod;
 *  - the read is tenant-scoped like every other statement in the repo.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database, so `pnpm
 * verify` stays green on a machine without Docker:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/post-job-repo.spacing.integration.test.ts
 *
 * NEVER point TEST_DATABASE_URL at the production database: this file inserts
 * and deletes its own tenants.
 */

const url = process.env.TEST_DATABASE_URL;
const MAX_SPACING_MS = 24 * 60 * 60_000;

describe.skipIf(!url)("DrizzlePostJobRepo — per-run spacing (real database)", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzlePostJobRepo(handle.db);
  const tenantId = testTenantId(randomUUID());
  const otherTenantId = testTenantId(randomUUID());

  beforeAll(async () => {
    await handle.db.insert(tenants).values([
      { id: tenantId, name: "spacing fixture" },
      { id: otherTenantId, name: "spacing fixture (other)" },
    ]);
  });

  afterAll(async () => {
    // Cascades to post_batch and post_job.
    await handle.db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
    await handle.close();
  });

  // --- Edge cases first -----------------------------------------------------

  it("reads NULL for a batch written before the column existed", async () => {
    const batchId = randomUUID();
    // No `spacingMs` on purpose: exactly what a pre-migration row looks like.
    await handle.db.insert(postBatches).values({ id: batchId, tenantId, productCode: "WH001" });

    await expect(repo.findBatchSpacingMs(tenantId, batchId)).resolves.toBeNull();
  });

  it("reads NULL for a batch id that does not exist", async () => {
    await expect(repo.findBatchSpacingMs(tenantId, randomUUID())).resolves.toBeNull();
  });

  it("refuses an empty batch id instead of scanning", async () => {
    await expect(repo.findBatchSpacingMs(tenantId, "  ")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("does not read another tenant's batch", async () => {
    const batchId = randomUUID();
    await handle.db
      .insert(postBatches)
      .values({ id: batchId, tenantId: otherTenantId, productCode: "WH002", spacingMs: 300_000 });

    await expect(repo.findBatchSpacingMs(tenantId, batchId)).resolves.toBeNull();
    await expect(repo.findBatchSpacingMs(otherTenantId, batchId)).resolves.toBe(300_000);
  });

  it("lets the CHECK constraint refuse a value that bypassed every guard", async () => {
    for (const spacingMs of [-1, MAX_SPACING_MS + 1]) {
      let caught: unknown;
      try {
        await handle.db
          .insert(postBatches)
          .values({ id: randomUUID(), tenantId, productCode: "WH003", spacingMs });
      } catch (error) {
        caught = error;
      }
      expect(caught, `spacing ${spacingMs} must not be storable`).toBeDefined();
      // The driver hangs the constraint name off the cause; the message itself
      // is just the failed query.
      const pg = findPgError(caught) as { constraint_name?: string } | null;
      expect(pg?.constraint_name).toBe("post_batch_spacing_ms_range");
    }
  });

  // --- Round trip through the write path the usecase uses -------------------

  it.each([
    ["0 (spacing off for this run)", 0],
    ["a gap under the 5-minute recommendation", 60_000],
    ["a five-minute gap", 300_000],
    ["the 24h ceiling", MAX_SPACING_MS],
  ])("stores and reads back %s", async (_case, spacingMs) => {
    const batchId = randomUUID();
    await repo.createBatchWithJobs({
      batch: {
        id: batchId,
        tenantId,
        productCode: "WH010",
        color: "",
        format: "image_post",
        note: null,
        createdBy: null,
        spacingMs,
      },
      jobs: [
        {
          id: randomUUID(),
          tenantId,
          batchId,
          productCode: "WH010",
          productOrigin: "sheet",
          color: "",
          channelId: `fbpage-${spacingMs}`,
          format: "image_post",
          captionText: "caption",
          media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
          scheduledAt: null,
        },
      ],
    });

    await expect(repo.findBatchSpacingMs(tenantId, batchId)).resolves.toBe(spacingMs);
    const rows = await handle.db
      .select({ spacingMs: postBatches.spacingMs })
      .from(postBatches)
      .where(eq(postBatches.id, batchId));
    expect(rows[0]?.spacingMs).toBe(spacingMs);
  });

  it("stores NULL when the creator omits the gap — the tenant setting keeps applying", async () => {
    const batchId = randomUUID();
    await repo.createBatchWithJobs({
      batch: {
        id: batchId,
        tenantId,
        productCode: "WH011",
        color: "",
        format: "image_post",
        note: null,
        createdBy: null,
      },
      jobs: [
        {
          id: randomUUID(),
          tenantId,
          batchId,
          productCode: "WH011",
          productOrigin: "sheet",
          color: "",
          channelId: "fbpage-null",
          format: "image_post",
          captionText: "caption",
          media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
          scheduledAt: null,
        },
      ],
    });

    await expect(repo.findBatchSpacingMs(tenantId, batchId)).resolves.toBeNull();
  });
});
