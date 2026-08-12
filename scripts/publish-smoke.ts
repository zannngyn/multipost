import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import {
  auditLogs,
  postBatches,
  postJobs,
  products,
  tenantIntegrations,
  tenants,
} from "@/adapters/db/schema";
import { DEMO_TENANT_ID } from "@/adapters/db/seed";
import { makeFakeChannelPublisher } from "@/adapters/meta/fake-publisher";
import { startBullMqJobConsumer } from "@/adapters/queue/bullmq-job-consumer";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { loadConfig } from "@/composition/config";
import { closeContainer, makeInfra, makeUsecases } from "@/composition/container";
import { PUBLISH_POST_JOB_NAME } from "@/core/usecases/publish-post";
import { makePublishPostHandler } from "@/worker/jobs/publish-post-job";
import { AppError } from "@/core/domain/errors";
import { transitionPostJob } from "@/core/domain/post-job";

/**
 * E5/E7 end-to-end smoke test on a REAL Postgres + REAL Redis, with the
 * FakeChannelPublisher standing in for Graph API (no Page token exists yet).
 *
 * It walks the seven cases the sprint has to prove:
 *   a) fan-out: one post, two channels -> two queued jobs
 *   b) worker publishes both; spacing gate keeps two posts of one channel apart
 *   c) same batch id twice -> DUPLICATE_POST_BLOCKED from the unique index
 *   d) transient channel failure -> retries, other channel unaffected
 *   e) stock hits 0 after queueing -> blocked BEFORE the publisher is called
 *   f) expired token -> blocked, no retry
 *   g) two concurrent claims of one job -> exactly one wins
 *
 *   DATABASE_URL=... REDIS_URL=... NODE_ENV=development \
 *     pnpm exec tsx scripts/publish-smoke.ts
 */

const CHANNEL_A = "fbpage-a";
const CHANNEL_B = "fbpage-b";
const PRODUCT_A = "MGKVX6310";
const PRODUCT_B = "MR0AC6080";
const SPACING_MS = 3_000;

const MEDIA = [
  { driveFileId: "drive-1", fileName: `${PRODUCT_A}-Tím (1).jpg`, url: "https://cdn.example/1.jpg" },
  { driveFileId: "drive-2", fileName: `${PRODUCT_A}-Tím (3).jpg`, url: "https://cdn.example/3.jpg" },
];

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const infra = makeInfra(config, { serviceName: "publish-smoke" });
  const { db, logger } = infra;

  const connection = createRedisConnection({ url: config.REDIS_URL, logger });
  const queue = makeBullMqJobQueue({ connection, logger });
  const publisher = makeFakeChannelPublisher();
  const usecases = makeUsecases(infra, { queue, publisher });
  const repo = new DrizzlePostJobRepo(db);

  // --- Seed: tenant, 2 Facebook channels, 2 products ------------------------
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" })
    .onConflictDoNothing();

  const setChannels = async (spacingMs: number): Promise<void> => {
    await db
      .insert(tenantIntegrations)
      .values({
        tenantId: DEMO_TENANT_ID,
        provider: "meta",
        status: "active",
        config: {
          spacingMs,
          retryBackoffMs: 500,
          maxAttempts: 3,
          channels: [
            {
              channelId: CHANNEL_A,
              platform: "facebook",
              name: "Shop A",
              externalId: "100000000000001",
              accessToken: "fake-token-a",
              status: "active",
            },
            {
              channelId: CHANNEL_B,
              platform: "facebook",
              name: "Shop B",
              externalId: "100000000000002",
              accessToken: "fake-token-b",
              status: "active",
            },
          ],
        },
      })
      .onConflictDoUpdate({
        target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
        set: {
          status: "active",
          config: {
            spacingMs,
            retryBackoffMs: 500,
            maxAttempts: 3,
            channels: [
              {
                channelId: CHANNEL_A,
                platform: "facebook",
                name: "Shop A",
                externalId: "100000000000001",
                accessToken: "fake-token-a",
                status: "active",
              },
              {
                channelId: CHANNEL_B,
                platform: "facebook",
                name: "Shop B",
                externalId: "100000000000002",
                accessToken: "fake-token-b",
                status: "active",
              },
            ],
          },
        },
      });
  };
  await setChannels(SPACING_MS);

  const syncRunId = randomUUID();
  const seedProduct = async (code: string, name: string, stockRaw: string): Promise<void> => {
    await db
      .insert(products)
      .values({
        tenantId: DEMO_TENANT_ID,
        code,
        name,
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
        set: { stockRaw, lastSyncRunId: syncRunId },
      });
  };
  await seedProduct(PRODUCT_A, "Giannal", "104");
  await seedProduct(PRODUCT_B, "Penny", "50");

  // Clean slate for repeated runs (post_job cascades from post_batch).
  await db.delete(postJobs).where(eq(postJobs.tenantId, DEMO_TENANT_ID));
  await db.delete(postBatches).where(eq(postBatches.tenantId, DEMO_TENANT_ID));
  await db.delete(auditLogs).where(eq(auditLogs.tenantId, DEMO_TENANT_ID));

  const captions = {
    [CHANNEL_A]: "Giannal – NẮNG THÁNG TÁM GỌI TÊN",
    [CHANNEL_B]: "Giannal – MỘT NGÀY DỊU DÀNG",
  };

  // --- Case a: fan-out ------------------------------------------------------
  heading("a) create-post-batch: 1 bài x 2 kênh");
  const batch1 = randomUUID();
  const created1 = await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch1,
    productCode: PRODUCT_A,
    color: "Tím",
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: captions,
    media: MEDIA,
  });
  print({
    batchId: created1.batchId,
    batchStatus: created1.batchStatus,
    channels: created1.channels.map((entry) => ({
      channel: entry.channelId,
      status: entry.status,
      queued: entry.queued,
      queueJobId: entry.queueJobId,
    })),
  });
  const waitingJobs = await db
    .select({ id: postJobs.id, channel: postJobs.channelId, status: postJobs.status })
    .from(postJobs)
    .where(eq(postJobs.batchId, batch1));
  print({ rows_in_post_job: waitingJobs });
  const queueCounts = await connection.keys("bull:mysp-jobs:*");
  print({ redis_keys_for_queue: queueCounts.length });

  // --- Case b: worker publishes both, spacing visible -----------------------
  heading("b) worker chạy: cả 2 kênh published + giãn cách cùng kênh");
  const consumer = startBullMqJobConsumer({
    connection,
    logger,
    concurrency: 4,
    handlers: {
      [PUBLISH_POST_JOB_NAME]: makePublishPostHandler({ logger, publishPost: usecases.publishPost }),
    },
  });

  await waitForBatch(db, batch1, ["published"], 30_000);
  print({ batch1: await summarise(repo, batch1) });

  // Second batch on the SAME channels: the spacing gate must delay it.
  const batch2 = randomUUID();
  await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch2,
    productCode: PRODUCT_B,
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: {
      [CHANNEL_A]: "Penny – BƯỚC CHÂN MÙA HÈ",
      [CHANNEL_B]: "Penny – NHỊP THỞ THÁNG TÁM",
    },
    media: MEDIA,
  });
  await waitForBatch(db, batch2, ["published"], 60_000);

  const timeline = await db
    .select({
      channel: postJobs.channelId,
      product: postJobs.productCode,
      publishedAt: postJobs.publishedAt,
      postId: postJobs.publishedPostId,
      attempts: postJobs.attemptCount,
    })
    .from(postJobs)
    .where(eq(postJobs.tenantId, DEMO_TENANT_ID))
    .orderBy(postJobs.channelId, postJobs.publishedAt);
  print({
    spacing_ms_configured: SPACING_MS,
    timeline: timeline.map((row) => ({
      ...row,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    })),
    gap_per_channel_ms: gapsByChannel(timeline),
  });

  // --- Case c: same batch id twice -> duplicate blocked ---------------------
  heading("c) create-post-batch lặp lại cùng khoá -> DUPLICATE_POST_BLOCKED");
  try {
    await usecases.createPostBatch({
      tenantId: DEMO_TENANT_ID,
      batchId: batch1,
      productCode: PRODUCT_A,
      color: "Tím",
      channelIds: [CHANNEL_A, CHANNEL_B],
      captionByChannel: captions,
      media: MEDIA,
    });
    console.log("!! expected DUPLICATE_POST_BLOCKED, got success");
  } catch (error) {
    const appError = AppError.from(error);
    print({
      code: appError.code,
      message: appError.message,
      userMessage: appError.userMessage,
      context: appError.context,
    });
  }
  print({
    post_job_rows_for_batch1: (
      await db.select({ id: postJobs.id }).from(postJobs).where(eq(postJobs.batchId, batch1))
    ).length,
  });

  // Spacing off from here: the remaining cases are about retries and blocks.
  await setChannels(0);

  // --- Case d: transient failure on one channel only ------------------------
  heading("d) kênh A lỗi tạm thời 2 lần -> retry rồi published; kênh B không ảnh hưởng");
  publisher.setScenario(CHANNEL_A, { transientFailures: 2 });
  const batch3 = randomUUID();
  const callsBefore = publisher.callCount();
  await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch3,
    productCode: PRODUCT_A,
    color: "Tím",
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: captions,
    media: MEDIA,
  });
  await waitForBatch(db, batch3, ["published"], 60_000);
  print({
    batch3: await summarise(repo, batch3),
    publisher_calls_this_case: publisher.calls.slice(callsBefore).map((call) => ({
      channel: call.channelId,
      outcome: call.outcome,
      errorCode: call.errorCode,
      at: call.at.toISOString(),
    })),
  });
  publisher.setScenario(CHANNEL_A, null);

  // --- Case e: stock recheck right before the API call ----------------------
  heading("e) tồn về 0 sau khi vào hàng đợi -> blocked TRƯỚC khi gọi publisher");
  const batch4 = randomUUID();
  await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch4,
    productCode: PRODUCT_A,
    color: "Tím",
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: captions,
    media: MEDIA,
    // Small delay so the stock can change while the job waits in the queue —
    // exactly the "hẹn lịch, đêm bán hết hàng" scenario of brief §9.
    scheduledAt: new Date(Date.now() + 2_000),
  });
  await db
    .update(products)
    .set({ stockRaw: "0" })
    .where(eq(products.code, PRODUCT_A));
  console.log("stock of MGKVX6310 set to 0 while the jobs sit in the queue");
  const callsBeforeBlock = publisher.callCount();
  await waitForBatch(db, batch4, ["blocked"], 60_000);
  const batch4Calls = publisher.calls
    .slice(callsBeforeBlock)
    .filter((call) => call.idempotencyKey.startsWith(batch4));
  print({
    batch4: await summarise(repo, batch4),
    publisher_calls_for_batch4: batch4Calls.length,
    proof: batch4Calls.length === 0 ? "publisher NEVER called for this batch" : "LEAK",
  });
  await db.update(products).set({ stockRaw: "104" }).where(eq(products.code, PRODUCT_A));

  // --- Case f: expired token ------------------------------------------------
  heading("f) token hết hạn (Graph code 190) -> blocked TOKEN_EXPIRED, không retry");
  publisher.setScenario(CHANNEL_A, { graphError: { code: 190, error_subcode: 463, message: "Session expired" } });
  const batch5 = randomUUID();
  const callsBeforeToken = publisher.callCount(CHANNEL_A);
  await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch5,
    productCode: PRODUCT_A,
    color: "Tím",
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: captions,
    media: MEDIA,
  });
  await waitForBatch(db, batch5, ["published", "blocked"], 60_000);
  print({
    batch5: await summarise(repo, batch5),
    channel_a_calls: publisher.callCount(CHANNEL_A) - callsBeforeToken,
  });
  publisher.setScenario(CHANNEL_A, null);

  // --- Case h: the crash replay (business rule 4) ---------------------------
  heading("h) job chạy lại sau khi đã published -> KHÔNG đăng lần hai");
  const alreadyPublished = (
    await db
      .select({ id: postJobs.id, postId: postJobs.publishedPostId })
      .from(postJobs)
      .where(eq(postJobs.batchId, batch1))
  )[0];
  const callsBeforeReplay = publisher.callCount();
  await queue.enqueue(
    PUBLISH_POST_JOB_NAME,
    { tenantId: DEMO_TENANT_ID, postJobId: alreadyPublished.id },
    { jobId: `replay.${alreadyPublished.id}`, attempts: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const replayed = await repo.findJobById(DEMO_TENANT_ID, alreadyPublished.id);
  print({
    replayed_job: alreadyPublished.id,
    status: replayed?.status,
    attempt_count: replayed?.attemptCount,
    published_post_id: replayed?.publishedPostId,
    unchanged_post_id: replayed?.publishedPostId === alreadyPublished.postId,
    publisher_calls_during_replay: publisher.callCount() - callsBeforeReplay,
  });

  await consumer.close();

  // --- Case g: two concurrent claims of one job -----------------------------
  heading("g) 2 worker cùng claim 1 job -> đúng 1 thắng (optimistic WHERE status)");
  const batch6 = randomUUID();
  const raceJobId = randomUUID();
  await repo.createBatchWithJobs({
    batch: {
      id: batch6,
      tenantId: DEMO_TENANT_ID,
      productCode: PRODUCT_A,
      color: "TÍM",
      format: "image_post",
      note: "race test",
      createdBy: null,
    },
    jobs: [
      {
        id: raceJobId,
        tenantId: DEMO_TENANT_ID,
        batchId: batch6,
        productCode: PRODUCT_A,
        color: "TÍM",
        channelId: CHANNEL_A,
        format: "image_post",
        captionText: captions[CHANNEL_A],
        media: MEDIA,
        scheduledAt: null,
      },
    ],
  });
  const draft = await repo.findJobById(DEMO_TENANT_ID, raceJobId);
  if (!draft) throw new Error("race job disappeared");
  const queued = await repo.applyTransition({
    tenantId: DEMO_TENANT_ID,
    postJobId: raceJobId,
    from: "draft",
    next: transitionPostJob(draft, "queued", { reason: "RACE_SETUP" }),
    reason: "RACE_SETUP",
  });
  if (!queued) throw new Error("could not queue the race job");

  const claim = () =>
    repo.applyTransition({
      tenantId: DEMO_TENANT_ID,
      postJobId: raceJobId,
      from: "queued",
      next: transitionPostJob(queued, "publishing", { reason: "WORKER_CLAIMED" }),
      reason: "WORKER_CLAIMED",
    });
  const [first, second] = await Promise.all([claim(), claim()]);
  const auditForRace = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, raceJobId));
  print({
    winner_count: [first, second].filter(Boolean).length,
    loser_count: [first, second].filter((entry) => entry === null).length,
    job_status: (await repo.findJobById(DEMO_TENANT_ID, raceJobId))?.status,
    audit_rows: auditForRace.map((row) => row.action),
  });

  // --- Final state ----------------------------------------------------------
  heading("Tổng kết post_job + audit_log");
  const finalRows = await db
    .select({
      batch: postJobs.batchId,
      channel: postJobs.channelId,
      product: postJobs.productCode,
      status: postJobs.status,
      attempts: postJobs.attemptCount,
      errorCode: postJobs.lastErrorCode,
      errorMessage: postJobs.lastErrorMessage,
      postId: postJobs.publishedPostId,
      url: postJobs.publishedUrl,
    })
    .from(postJobs)
    .where(eq(postJobs.tenantId, DEMO_TENANT_ID))
    .orderBy(postJobs.createdAt, postJobs.channelId);
  print(finalRows);
  const audit = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, DEMO_TENANT_ID));
  const auditByAction = audit.reduce<Record<string, number>>((acc, row) => {
    acc[row.action] = (acc[row.action] ?? 0) + 1;
    return acc;
  }, {});
  print({ audit_log_rows: audit.length, by_action: auditByAction });
  print({ fake_publisher_total_calls: publisher.callCount(), published: publisher.publishedCount() });

  await queue.close();
  await connection.quit();
  await closeContainer();
}

// --- helpers ----------------------------------------------------------------

async function summarise(repo: DrizzlePostJobRepo, batchId: string) {
  const summary = await repo.getBatchSummary(DEMO_TENANT_ID, batchId);
  if (!summary) return null;
  return {
    status: summary.status,
    total: summary.total,
    jobs: summary.jobs.map((job) => ({
      channel: job.channelId,
      status: job.status,
      attempts: job.attemptCount,
      postId: job.publishedPostId,
      url: job.publishedUrl,
      errorCode: job.lastErrorCode,
      errorMessage: job.lastErrorMessage,
      publishedAt: job.publishedAt?.toISOString() ?? null,
    })),
  };
}

type Db = ReturnType<typeof makeInfra>["db"];

/** Polls until every job of the batch reached one of `finalStatuses`. */
async function waitForBatch(
  db: Db,
  batchId: string,
  finalStatuses: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select({ status: postJobs.status })
      .from(postJobs)
      .where(eq(postJobs.batchId, batchId));
    if (rows.length > 0 && rows.every((row) => finalStatuses.includes(row.status))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timeout waiting for batch ${batchId}: ${rows.map((row) => row.status).join(",")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function gapsByChannel(
  rows: Array<{ channel: string; publishedAt: Date | null }>,
): Record<string, number[]> {
  const byChannel: Record<string, number[]> = {};
  const times: Record<string, number[]> = {};
  for (const row of rows) {
    if (!row.publishedAt) continue;
    (times[row.channel] ??= []).push(row.publishedAt.getTime());
  }
  for (const [channel, list] of Object.entries(times)) {
    list.sort((a, b) => a - b);
    byChannel[channel] = list.slice(1).map((value, index) => value - list[index]);
  }
  return byChannel;
}

main().catch((error: unknown) => {
  const appError = AppError.from(error, "INTERNAL");
  console.error(JSON.stringify(appError.toLogObject(), null, 2));
  process.exit(1);
});
