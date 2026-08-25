import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDbHandle } from "./client";
import { DrizzlePostJobRepo } from "./post-job-repo.drizzle";
import { postBatches, postJobs, tenants } from "./schema";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * `post_job.product_origin` against a REAL Postgres (onboarding phase 3).
 *
 * A stubbed query builder cannot prove any of what matters here:
 *  - the enum column accepts what `NewPostJob` promises and comes back on the
 *    domain object, so the tracking screens can answer "bài này lấy dữ liệu từ
 *    đâu" without a join;
 *  - a row written WITHOUT the column — every post that existed before the
 *    migration — reads back as `sheet`, which is the truth for them: there was
 *    no manual product before phase 3.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database, so `pnpm
 * verify` stays green on a machine without Docker:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/post-job-repo.product-origin.integration.test.ts
 *
 * NEVER point TEST_DATABASE_URL at the production database: this file inserts
 * and deletes its own tenant.
 */

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("DrizzlePostJobRepo — product origin (real database)", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzlePostJobRepo(handle.db);
  const tenantId = testTenantId(randomUUID());

  beforeAll(async () => {
    await handle.db.insert(tenants).values({ id: tenantId, name: "product-origin fixture" });
  });

  afterAll(async () => {
    // Cascades to post_batch and post_job.
    await handle.db.delete(tenants).where(inArray(tenants.id, [tenantId]));
    await handle.close();
  });

  it("reads back `sheet` for a row written before the column existed", async () => {
    const batchId = randomUUID();
    const jobId = randomUUID();
    await handle.db.insert(postBatches).values({ id: batchId, tenantId, productCode: "WH001" });
    // No `productOrigin` on purpose: exactly what a pre-migration row looks like
    // once the DEFAULT has backfilled it.
    await handle.db.insert(postJobs).values({
      id: jobId,
      tenantId,
      batchId,
      productCode: "WH001",
      color: "",
      channelId: "fbpage-legacy",
      format: "image_post",
      status: "published",
      captionText: "legacy row",
      media: [],
    });

    const stored = await repo.findJobById(tenantId, jobId);
    expect(stored?.productOrigin).toBe("sheet");

    const summary = await repo.getBatchSummary(tenantId, batchId);
    expect(summary?.jobs[0]?.productOrigin).toBe("sheet");
  });

  it("round-trips the stamp of a batch built on typed product data", async () => {
    const batchId = randomUUID();
    const created = await repo.createBatchWithJobs({
      batch: {
        id: batchId,
        tenantId,
        productCode: "WH002",
        color: "TÍM",
        format: "image_post",
        note: null,
        createdBy: null,
      },
      jobs: ["fbpage-a", "fbpage-b"].map((channelId) => ({
        id: randomUUID(),
        tenantId,
        batchId,
        productCode: "WH002",
        productOrigin: "manual" as const,
        color: "TÍM",
        channelId,
        format: "image_post" as const,
        captionText: `caption ${channelId}`,
        media: [],
        scheduledAt: null,
      })),
    });

    // The insert already returns the domain objects the caller will use.
    expect(created.jobs.map((job) => job.productOrigin)).toEqual(["manual", "manual"]);

    // ...and every read path the tracking screens use agrees with the column.
    const summary = await repo.getBatchSummary(tenantId, batchId);
    expect(summary?.jobs.map((job) => job.productOrigin)).toEqual(["manual", "manual"]);

    const page = await repo.listJobs({ tenantId, batchId, limit: 10 });
    expect(page.items.map((job) => job.productOrigin)).toEqual(["manual", "manual"]);

    const rows = await handle.db
      .select({ origin: postJobs.productOrigin })
      .from(postJobs)
      .where(eq(postJobs.batchId, batchId));
    expect(rows.map((row) => row.origin)).toEqual(["manual", "manual"]);
  });

  it("keeps each batch's own stamp — a synced batch is not coloured by a manual one", async () => {
    const batchId = randomUUID();
    await repo.createBatchWithJobs({
      batch: {
        id: batchId,
        tenantId,
        productCode: "WH003",
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
          productCode: "WH003",
          productOrigin: "sheet" as const,
          color: "",
          channelId: "fbpage-a",
          format: "image_post" as const,
          captionText: "synced caption",
          media: [],
          scheduledAt: null,
        },
      ],
    });

    const summary = await repo.getBatchSummary(tenantId, batchId);
    expect(summary?.jobs.map((job) => job.productOrigin)).toEqual(["sheet"]);
  });
});
