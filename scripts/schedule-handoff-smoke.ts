import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { sealMetaConfig } from "@/adapters/db/channel-config-repo.drizzle";
import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import {
  auditLogs,
  postBatches,
  postJobs,
  products,
  tenantIntegrations,
  tenants,
} from "@/adapters/db/schema";
import { DEMO_TENANT_ID } from "@/adapters/db/seed-constants";
import { makeFakeChannelPublisher } from "@/adapters/meta/fake-publisher";
import { startBullMqJobConsumer } from "@/adapters/queue/bullmq-job-consumer";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { loadConfig } from "@/composition/config";
import { closeContainer, makeInfra, makeTenantSecretBox, makeUsecases } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { HANDOFF_WINDOW_START_MS } from "@/core/domain/post-job";
import { PUBLISH_POST_JOB_NAME } from "@/core/usecases/publish-post";
import { makePublishPostHandler } from "@/worker/jobs/publish-post-job";

import { assertSafeToSeed } from "./smoke-guard";

/**
 * E8.6 end-to-end smoke on a REAL Postgres + REAL Redis, with the
 * FakeChannelPublisher standing in for Graph API.
 *
 * It proves the part unit tests cannot: that the WHOLE stack (create batch ->
 * BullMQ delayed entry -> worker -> handoff -> DB state -> reconciliation ->
 * cancel) behaves as designed on real infrastructure.
 *
 *   a) a post scheduled inside the window is HANDED OVER, not published
 *   b) the reconciler leaves it alone while Facebook still holds it
 *   c) once Facebook publishes it, the job becomes `published` with the
 *      platform's own permalink
 *   d) cancelling a handed-over post deletes it on the platform FIRST
 *   e) a sold-out product is blocked BEFORE anything reaches the platform
 *   f) a far-future post sleeps in the queue until T-30, not until T
 *   g) rescheduling a handed-over post is refused with a Vietnamese sentence
 *
 *   DATABASE_URL=... REDIS_URL=... NODE_ENV=development \
 *     pnpm exec tsx scripts/schedule-handoff-smoke.ts
 */

const CHANNEL = "fbpage-a";
const PRODUCT = "MGKVX6310";
const MEDIA = [
  { driveFileId: "drive-1", fileName: `${PRODUCT}-Tím (1).jpg`, kind: "image" as const },
  { driveFileId: "drive-2", fileName: `${PRODUCT}-Tím (3).jpg`, kind: "image" as const },
];

/** 1x1 PNG: enough to prove bytes travelled. */
const PHOTO_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const infra = makeInfra(config, { serviceName: "schedule-handoff-smoke" });
  const { db, logger } = infra;

  const connection = createRedisConnection({ url: config.REDIS_URL, logger });
  const queue = makeBullMqJobQueue({ connection, logger });
  const publisher = makeFakeChannelPublisher();
  const usecases = makeUsecases(infra, {
    queue,
    publisher,
    publishers: { facebook: publisher },
    readMediaBytes: async () => ({ bytes: PHOTO_BYTES, mimeType: "image/png" }),
  });
  const repo = new DrizzlePostJobRepo(db);
  // Same box the container wires, so what this script seeds is what production
  // reads (adapters/db/secret-box).
  const secretBox = makeTenantSecretBox(logger);

  // Before the first write: seeding REPLACES the tenant_integration row, so a
  // database holding real Fanpages would lose them and their Page tokens.
  await assertSafeToSeed({
    db,
    ownedChannelIds: [CHANNEL],
    scriptName: "schedule-handoff-smoke",
  });

  // --- Seed ------------------------------------------------------------------
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" })
    .onConflictDoNothing();

  const integrationConfig = sealMetaConfig(
    {
      // No spacing: this script measures the handoff window, not the gate.
      spacingMs: 0,
      retryBackoffMs: 500,
      maxAttempts: 3,
      channels: [
        {
          channelId: CHANNEL,
          platform: "facebook",
          name: "Shop A",
          externalId: "100000000000001",
          accessToken: "fake-token-a",
          status: "active",
        },
      ],
    },
    secretBox,
  );
  await db
    .insert(tenantIntegrations)
    .values({
      tenantId: DEMO_TENANT_ID,
      provider: "meta",
      status: "active",
      config: integrationConfig,
    })
    .onConflictDoUpdate({
      target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
      set: { status: "active", config: integrationConfig },
    });

  const syncRunId = randomUUID();
  const setStock = async (stockRaw: string): Promise<void> => {
    await db
      .insert(products)
      .values({
        tenantId: DEMO_TENANT_ID,
        code: PRODUCT,
        name: "Giannal",
        description: "Chất liệu lụa mềm, dáng suông.",
        category: "Váy",
        season: "Hè 2026",
        stockRaw,
        noteRaw: "",
        colorsRaw: "TÍM",
        hasConflict: false,
        sourceRows: [2],
        lastSyncRunId: syncRunId,
      })
      .onConflictDoUpdate({
        target: [products.tenantId, products.code],
        set: { stockRaw, noteRaw: "", lastSyncRunId: syncRunId },
      });
  };
  await setStock("104");

  // Clean slate for repeated runs (post_job cascades from post_batch).
  await db.delete(postJobs).where(eq(postJobs.tenantId, DEMO_TENANT_ID));
  await db.delete(postBatches).where(eq(postBatches.tenantId, DEMO_TENANT_ID));
  await db.delete(auditLogs).where(eq(auditLogs.tenantId, DEMO_TENANT_ID));

  const consumer = startBullMqJobConsumer({
    connection,
    logger,
    concurrency: 2,
    handlers: {
      [PUBLISH_POST_JOB_NAME]: makePublishPostHandler({ logger, publishPost: usecases.publishPost }),
    },
  });

  const schedule = async (offsetMs: number, batchId = randomUUID()) => {
    const created = await usecases.createPostBatch({
      tenantId: DEMO_TENANT_ID,
      batchId,
      productCode: PRODUCT,
      color: "Tím",
      channelIds: [CHANNEL],
      captionByChannel: { [CHANNEL]: "Giannal – MỘT NGÀY DỊU DÀNG" },
      media: MEDIA,
      scheduledAt: new Date(Date.now() + offsetMs),
    });
    return { batchId, created, postJobId: created.channels[0].postJobId };
  };

  const waitForStatus = async (postJobId: string, wanted: string[], timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await repo.findJobById(DEMO_TENANT_ID, postJobId);
      if (job && wanted.includes(job.status)) return job;
      if (Date.now() > deadline) {
        throw new Error(`Timeout waiting for ${wanted.join("/")}, got ${job?.status ?? "missing"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  try {
    // --- a) inside the window: handed over, NOT published --------------------
    heading("a) hẹn T+20' → giao cho Facebook giữ (không đăng)");
    const first = await schedule(20 * 60_000);
    const handed = await waitForStatus(first.postJobId, ["scheduled_on_facebook"]);
    print({
      status: handed.status,
      scheduled_post_id: handed.scheduledPostId,
      published_post_id: handed.publishedPostId,
      published_at: handed.publishedAt,
      queue_job_id: handed.queueJobId,
      platform_calls: {
        published: publisher.publishedCount(),
        scheduled: publisher.scheduledCount(),
      },
    });
    assert(handed.status === "scheduled_on_facebook", "the job must be scheduled_on_facebook");
    assert(handed.publishedPostId === null, "nothing may be marked published yet");
    assert(publisher.publishedCount() === 0, "the platform must NOT have published anything");
    assert(publisher.scheduledCount() === 1, "the platform must have taken exactly one schedule");
    assert(handed.scheduledPostId !== null, "the platform post id must be stored");

    const audit = await db
      .select({ action: auditLogs.action, payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, first.postJobId));
    print({ audit_actions: audit.map((row) => row.action) });
    assert(
      audit.some((row) => row.action === "post_job.scheduled_on_facebook"),
      "the handoff must leave an audit row",
    );

    // --- b) reconciler while Facebook still holds it ------------------------
    // The hour is 20 minutes away, and waiting for it would make this script a
    // 20-minute script: the row is backdated instead, which is exactly what the
    // clock does on its own. Everything else (the handoff above, the reconciler
    // below) is the real code path.
    heading("b) đối soát khi Facebook chưa đăng → vẫn chờ");
    await db
      .update(postJobs)
      .set({ scheduledAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(postJobs.id, first.postJobId));
    const stillWaiting = await usecases.reconcileScheduledPosts({ graceMs: 1_000 });
    print(stillWaiting);
    assert(stillWaiting.published === 0, "nothing may be published before Facebook says so");
    const afterFirstSweep = await repo.findJobById(DEMO_TENANT_ID, first.postJobId);
    assert(
      afterFirstSweep?.status === "scheduled_on_facebook",
      "the job must stay handed over until the platform confirms",
    );

    // --- c) Facebook published it -> the reconciler closes the job ------------
    heading("c) Facebook đã đăng → đối soát chuyển sang published + link thật");
    const platformPostId = handed.scheduledPostId as string;
    publisher.setRemoteState(platformPostId, {
      state: "published",
      postId: platformPostId,
      url: `https://www.facebook.com/100000000000001/posts/${platformPostId}`,
      publishedAt: new Date(),
    });
    const closed = await usecases.reconcileScheduledPosts({ graceMs: 1_000 });
    print(closed);
    const published = await repo.findJobById(DEMO_TENANT_ID, first.postJobId);
    print({
      status: published?.status,
      published_post_id: published?.publishedPostId,
      published_url: published?.publishedUrl,
      published_at: published?.publishedAt?.toISOString() ?? null,
    });
    assert(published?.status === "published", "the reconciler must close the job");
    assert(
      published?.publishedUrl?.includes("/posts/") === true,
      "the link must be the platform's own permalink",
    );
    assert(publisher.publishedCount() === 0, "the reconciler must never publish anything itself");

    // --- d) cancelling a post Facebook holds ---------------------------------
    heading("d) huỷ bài Facebook đang giữ → gỡ trên Facebook trước, rồi mới blocked");
    const second = await schedule(20 * 60_000);
    const secondHanded = await waitForStatus(second.postJobId, ["scheduled_on_facebook"]);
    const cancelled = await usecases.cancelScheduledJob({
      tenantId: DEMO_TENANT_ID,
      postJobId: second.postJobId,
      note: "khách đổi ý",
    });
    print({
      status: cancelled.status,
      platform_post_deleted: cancelled.platformPostDeleted,
      user_message: cancelled.userMessage,
      deleted_on_platform: publisher.deletedPostIds,
    });
    assert(cancelled.platformPostDeleted, "the platform post must be deleted");
    assert(
      publisher.deletedPostIds.includes(secondHanded.scheduledPostId as string),
      "the deleted id must be the one Facebook was holding",
    );
    const cancelledRow = await repo.findJobById(DEMO_TENANT_ID, second.postJobId);
    assert(cancelledRow?.status === "blocked", "the row must end blocked");
    assert(cancelledRow?.lastErrorCode === "OPERATOR_CANCELLED", "with the cancel error code");

    // --- e) sold out at handoff time -----------------------------------------
    heading("e) hết hàng ngay trước giờ giao → chặn, KHÔNG giao cho Facebook");
    const callsBefore = publisher.callCount();
    await setStock("0");
    const third = await schedule(20 * 60_000);
    const blocked = await waitForStatus(third.postJobId, ["blocked"]);
    print({
      status: blocked.status,
      error_code: blocked.lastErrorCode,
      user_message: blocked.lastErrorMessage,
      platform_calls_since: publisher.callCount() - callsBefore,
    });
    assert(blocked.lastErrorCode === "OUT_OF_STOCK", "the stock gate must be the reason");
    assert(
      publisher.callCount() === callsBefore,
      "the platform must not have been called at all for a sold-out product",
    );
    await setStock("104");

    // --- f) far future: the entry sleeps until T-30 --------------------------
    heading("f) hẹn T+2h → hàng đợi ngủ tới T-30, bài vẫn queued");
    const fourth = await schedule(2 * 60 * 60_000);
    const delayed = await repo.findJobById(DEMO_TENANT_ID, fourth.postJobId);
    const delayedEntries = await connection.zrange("bull:mysp-jobs:delayed", "0", "-1");
    print({
      status: delayed?.status,
      queue_job_id: delayed?.queueJobId,
      scheduled_at: delayed?.scheduledAt?.toISOString() ?? null,
      wake_expected_at: new Date(
        (delayed?.scheduledAt?.getTime() ?? 0) - HANDOFF_WINDOW_START_MS,
      ).toISOString(),
      delayed_entries_in_redis: delayedEntries.length,
    });
    assert(delayed?.status === "queued", "a far-future post must simply wait");
    assert(delayedEntries.length > 0, "its delayed entry must exist in Redis");

    // --- g) rescheduling a handed-over post is refused -----------------------
    heading("g) đổi giờ bài đã giao cho Facebook → từ chối có kiểm soát");
    const fifth = await schedule(20 * 60_000);
    await waitForStatus(fifth.postJobId, ["scheduled_on_facebook"]);
    try {
      await usecases.reschedulePostJob({
        tenantId: DEMO_TENANT_ID,
        postJobId: fifth.postJobId,
        newScheduledAt: new Date(Date.now() + 90 * 60_000),
      });
      throw new Error("ASSERTION FAILED: rescheduling a handed-over post must be refused");
    } catch (error) {
      const appError = AppError.from(error, "INTERNAL");
      print({ code: appError.code, user_message: appError.userMessage });
      assert(appError.code === "INVALID_JOB_TRANSITION", "the refusal must be a typed error");
      assert(
        appError.userMessage.includes("Huỷ"),
        "the refusal must tell the operator what to do instead",
      );
    }

    heading("KẾT QUẢ");
    print({
      platform_published_calls: publisher.publishedCount(),
      platform_scheduled_calls: publisher.scheduledCount(),
      platform_deleted: publisher.deletedPostIds,
      verdict: "OK",
    });
  } finally {
    await consumer.close();
    await queue.close();
    await connection.quit();
    await closeContainer();
  }
}

main().catch((error: unknown) => {
  const appError = AppError.from(error, "INTERNAL");
  console.error(JSON.stringify(appError.toLogObject(), null, 2));
  process.exit(1);
});
