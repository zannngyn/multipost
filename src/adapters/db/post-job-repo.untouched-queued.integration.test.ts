import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { PostJobStatus } from "@/core/domain/post-job";

import { makeDbHandle } from "./client";
import { DrizzlePostJobRepo } from "./post-job-repo.drizzle";
import { postBatches, postJobs, tenants } from "./schema";

/**
 * `countUntouchedQueued` against a REAL Postgres. The whole value of this query
 * is its WHERE clause, and a stubbed query builder proves nothing about it:
 *
 *  - a post hẹn giờ for tomorrow is `queued` + `attempt_count = 0` BY DESIGN and
 *    must NOT be counted (that would raise "worker chết" every time someone
 *    schedules a post);
 *  - a post whose hour has passed and is still untouched MUST be counted;
 *  - tenant A must never see tenant B's rows;
 *  - the waiting-since instant is `greatest(created_at, scheduled_at)`, so a
 *    long-planned post does not report days of delay the second it becomes due.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database, so `pnpm
 * verify` stays green on a machine without Docker:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/post-job-repo.untouched-queued.integration.test.ts
 *
 * NEVER point TEST_DATABASE_URL at the production database: this file inserts
 * and deletes its own tenants/batches/jobs.
 */

const url = process.env.TEST_DATABASE_URL;

const NOW = new Date("2026-08-17T10:00:00.000Z");
const MINUTE = 60_000;

describe.skipIf(!url)("DrizzlePostJobRepo.countUntouchedQueued (real database)", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzlePostJobRepo(handle.db);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const batchA = randomUUID();
  const batchB = randomUUID();

  interface JobSeed {
    readonly tenantId: string;
    readonly batchId: string;
    readonly channelId: string;
    readonly status?: PostJobStatus;
    readonly attemptCount?: number;
    readonly createdAt?: Date;
    readonly scheduledAt?: Date | null;
  }

  async function seedJob(seed: JobSeed): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(postJobs).values({
      id,
      tenantId: seed.tenantId,
      batchId: seed.batchId,
      productCode: "WH001",
      color: seed.channelId,
      channelId: seed.channelId,
      format: "image_post",
      status: seed.status ?? "queued",
      attemptCount: seed.attemptCount ?? 0,
      captionText: "worker health fixture",
      media: [],
      scheduledAt: seed.scheduledAt ?? null,
      createdAt: seed.createdAt ?? new Date(NOW.getTime() - 30 * MINUTE),
      updatedAt: seed.createdAt ?? new Date(NOW.getTime() - 30 * MINUTE),
    });
    return id;
  }

  beforeAll(async () => {
    await handle.db.insert(tenants).values([
      { id: tenantA, name: "worker-health A" },
      { id: tenantB, name: "worker-health B" },
    ]);
    await handle.db.insert(postBatches).values([
      { id: batchA, tenantId: tenantA, productCode: "WH001" },
      { id: batchB, tenantId: tenantB, productCode: "WH001" },
    ]);
  });

  afterAll(async () => {
    // Cascades to post_batch and post_job.
    await handle.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await handle.close();
  });

  async function clearJobs(): Promise<void> {
    await handle.db.delete(postJobs).where(inArray(postJobs.tenantId, [tenantA, tenantB]));
  }

  // --- Edge cases first -----------------------------------------------------

  it("counts nothing and reports no wait when the tenant has no jobs", async () => {
    await clearJobs();

    expect(await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW })).toEqual({
      count: 0,
      oldestWaitingSince: null,
    });
  });

  it("does NOT count a scheduled post whose hour has not come", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-tomorrow",
      scheduledAt: new Date(NOW.getTime() + 24 * 60 * MINUTE),
    });

    // Waiting on purpose: this is what hẹn giờ means, not a symptom.
    expect(await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW })).toEqual({
      count: 0,
      oldestWaitingSince: null,
    });
  });

  it("counts a scheduled post whose hour has passed, and dates the wait from that hour", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-overdue",
      // Planned a week ago FOR ten minutes ago: it has been waiting 10 minutes.
      createdAt: new Date(NOW.getTime() - 7 * 24 * 60 * MINUTE),
      scheduledAt: new Date(NOW.getTime() - 10 * MINUTE),
    });

    const result = await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW });

    expect(result.count).toBe(1);
    expect(result.oldestWaitingSince?.toISOString()).toBe(
      new Date(NOW.getTime() - 10 * MINUTE).toISOString(),
    );
  });

  it("dates the wait from creation when a past hour predates the row", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-backdated",
      createdAt: new Date(NOW.getTime() - 5 * MINUTE),
      // Someone scheduled a post for a time that had already passed.
      scheduledAt: new Date(NOW.getTime() - 60 * MINUTE),
    });

    const result = await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW });

    expect(result.count).toBe(1);
    expect(result.oldestWaitingSince?.toISOString()).toBe(
      new Date(NOW.getTime() - 5 * MINUTE).toISOString(),
    );
  });

  it("ignores jobs that were already attempted, and every non-queued status", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-retrying",
      attemptCount: 1,
    });
    const otherStatuses: PostJobStatus[] = [
      "draft",
      "publishing",
      "scheduled_on_facebook",
      "published",
      "failed",
      "blocked",
    ];
    for (const status of otherStatuses) {
      await seedJob({
        tenantId: tenantA,
        batchId: batchA,
        channelId: `fbpage-${status}`,
        status,
      });
    }

    expect(await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW })).toEqual({
      count: 0,
      oldestWaitingSince: null,
    });
  });

  it("never counts another tenant's stuck jobs", async () => {
    await clearJobs();
    await seedJob({ tenantId: tenantB, batchId: batchB, channelId: "fbpage-b" });

    expect(await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW })).toEqual({
      count: 0,
      oldestWaitingSince: null,
    });
    expect((await repo.countUntouchedQueued({ tenantId: tenantB, now: NOW })).count).toBe(1);
  });

  it.each([
    ["a malformed tenant id", { tenantId: "not-a-uuid", now: NOW }],
    ["a missing clock", { tenantId: "00000000-0000-4000-8000-000000000000", now: undefined }],
  ])("rejects %s with INVALID_INPUT", async (_label, query) => {
    const error = await repo
      .countUntouchedQueued(query as never)
      .catch((e: unknown) => e);

    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe("INVALID_INPUT");
  });

  // --- Happy path -----------------------------------------------------------

  it("counts every due untouched job and reports the oldest wait", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-now-1",
      createdAt: new Date(NOW.getTime() - 20 * MINUTE),
    });
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-now-2",
      createdAt: new Date(NOW.getTime() - 3 * MINUTE),
    });
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-due",
      createdAt: new Date(NOW.getTime() - 90 * MINUTE),
      scheduledAt: new Date(NOW.getTime() - 8 * MINUTE),
    });
    // Distractors that must not move the numbers.
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-later",
      scheduledAt: new Date(NOW.getTime() + 60 * MINUTE),
    });
    await seedJob({ tenantId: tenantB, batchId: batchB, channelId: "fbpage-b" });

    const result = await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW });

    expect(result.count).toBe(3);
    expect(result.oldestWaitingSince?.toISOString()).toBe(
      new Date(NOW.getTime() - 20 * MINUTE).toISOString(),
    );
  });

  it("uses the caller's `now`, so the same rows read differently later", async () => {
    await clearJobs();
    await seedJob({
      tenantId: tenantA,
      batchId: batchA,
      channelId: "fbpage-in-30",
      scheduledAt: new Date(NOW.getTime() + 30 * MINUTE),
    });

    expect((await repo.countUntouchedQueued({ tenantId: tenantA, now: NOW })).count).toBe(0);
    expect(
      (
        await repo.countUntouchedQueued({
          tenantId: tenantA,
          now: new Date(NOW.getTime() + 31 * MINUTE),
        })
      ).count,
    ).toBe(1);
  });

  it("leaves no fixture behind for the next run", async () => {
    await clearJobs();
    const rows = await handle.db
      .select({ id: postJobs.id })
      .from(postJobs)
      .where(eq(postJobs.tenantId, tenantA));
    expect(rows).toHaveLength(0);
  });
});
