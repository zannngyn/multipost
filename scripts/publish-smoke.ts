import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  DrizzleChannelConfigRepo,
  sealMetaConfig,
} from "@/adapters/db/channel-config-repo.drizzle";
import { DrizzleChannelGroupRepo } from "@/adapters/db/channel-group-repo.drizzle";
import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import { DrizzleUserRepo } from "@/adapters/db/user-repo.drizzle";
import {
  auditLogs,
  channelGroups,
  users,
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
import { loadConfig, loadMediaConfig } from "@/composition/config";
import {
  closeContainer,
  makeInfra,
  makeTenantSecretBox,
  makeUsecases,
} from "@/composition/container";
import { makeGetBatchStatus } from "@/core/usecases/get-batch-status";
import { makeListPostJobs } from "@/core/usecases/list-post-jobs";
import { makeManageChannelGroups } from "@/core/usecases/manage-channel-groups";
import { PUBLISH_POST_JOB_NAME } from "@/core/usecases/publish-post";
import { makeRetryPostJob } from "@/core/usecases/retry-post-job";
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
 *   h) a job replayed after `published` -> nothing is posted twice
 *   i) get-batch-status: the per-channel table of a PARTIAL batch (E7.5)
 *   j) retry a `failed` job -> it runs again and publishes (E11.1)
 *   k) retry a `published` job -> INVALID_JOB_TRANSITION, no queue entry
 *   l) channel groups: CRUD + an unknown channel id is refused (E7.6)
 *
 *   DATABASE_URL=... REDIS_URL=... NODE_ENV=development \
 *     pnpm exec tsx scripts/publish-smoke.ts
 */

const CHANNEL_A = "fbpage-a";
const CHANNEL_B = "fbpage-b";
const PRODUCT_A = "MGKVX6310";
const PRODUCT_B = "MR0AC6080";
const SPACING_MS = 3_000;

/**
 * Callers pass ASSETS, never URLs (C0): create-post-batch signs each one, and
 * publish-post re-signs them right before the API call.
 */
const MEDIA = [
  { driveFileId: "drive-1", fileName: `${PRODUCT_A}-Tím (1).jpg`, kind: "image" },
  { driveFileId: "drive-2", fileName: `${PRODUCT_A}-Tím (3).jpg`, kind: "image" },
];

/** `/api/media/<assetId>?tenant=<uuid>&expires=<ms>&sig=<hex>` */
const SIGNED_MEDIA_URL =
  /^https?:\/\/[^/]+\/api\/media\/[A-Za-z0-9._-]+\?tenant=[0-9a-f-]{36}&expires=\d+&sig=[0-9a-f]+$/;

/** Never print a signed URL: the query carries a MAC. */
function redactUrl(url: string): string {
  return url.replace(/sig=[0-9a-f]+/, "sig=<redacted>");
}

function expiresOf(url: string): number | null {
  const match = /[?&]expires=(\d+)/.exec(url);
  return match ? Number.parseInt(match[1], 10) : null;
}

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

  // Same box the container wires, so what this script seeds is what production
  // reads (adapters/db/secret-box).
  const secretBox = makeTenantSecretBox(logger);
  // Same variable the container reads lazily; the script needs it for its asserts.
  const mediaBaseUrl = loadMediaConfig().MEDIA_PUBLIC_BASE_URL;
  const channelConfig = new DrizzleChannelConfigRepo(db, { box: secretBox, logger });
  const getBatchStatus = makeGetBatchStatus({ postJobs: repo, logger });
  const listPostJobs = makeListPostJobs({ postJobs: repo, logger });
  const retryPostJob = makeRetryPostJob({
    postJobs: repo,
    channels: channelConfig,
    queue,
    clock: infra.clock,
    logger,
    // E11.1 audit: session e-mail -> app_user.id (wiring note in the report).
    users: new DrizzleUserRepo(db),
  });
  const groupRepo = new DrizzleChannelGroupRepo(db);
  const groupUsecases = makeManageChannelGroups({
    groups: groupRepo,
    channels: channelConfig,
    logger,
    newId: () => randomUUID(),
  });

  // --- Seed: tenant, 2 Facebook channels, 2 products ------------------------
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" })
    .onConflictDoNothing();

  /**
   * Channel A is stored SEALED (`enc:v1:...`), channel B is left as legacy
   * PLAINTEXT on purpose: both must be usable, and the plaintext one must warn.
   */
  const setChannels = async (spacingMs: number): Promise<void> => {
    const sealedChannelA = sealMetaConfig(
      {
        channelId: CHANNEL_A,
        platform: "facebook",
        name: "Shop A",
        externalId: "100000000000001",
        accessToken: "fake-token-a",
        status: "active",
      },
      secretBox,
    );
    const legacyChannelB = {
      channelId: CHANNEL_B,
      platform: "facebook",
      name: "Shop B",
      externalId: "100000000000002",
      accessToken: "fake-token-b",
      status: "active",
    };
    const config = {
      spacingMs,
      retryBackoffMs: 500,
      maxAttempts: 3,
      channels: [sealedChannelA, legacyChannelB],
    };
    await db
      .insert(tenantIntegrations)
      .values({ tenantId: DEMO_TENANT_ID, provider: "meta", status: "active", config })
      .onConflictDoUpdate({
        target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
        set: { status: "active", config },
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
  await db.delete(channelGroups).where(eq(channelGroups.tenantId, DEMO_TENANT_ID));

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

  // --- Media URLs: signed on create, RE-SIGNED before the API call (C0) -----
  heading("m) URL ảnh: ký lúc tạo job + KÝ LẠI ngay trước khi gọi publisher");
  const storedMedia = (
    await db
      .select({ media: postJobs.media, channel: postJobs.channelId })
      .from(postJobs)
      .where(eq(postJobs.batchId, batch1))
  ).flatMap((row) => (row.media ?? []).map((item) => ({ channel: row.channel, ...item })));
  const batch1Calls = publisher.calls.filter((call) => call.idempotencyKey.includes(batch1));
  print({
    stored_on_post_job: storedMedia.map((item) => ({
      channel: item.channel,
      driveFileId: item.driveFileId,
      url: redactUrl(item.url),
      shape_ok: SIGNED_MEDIA_URL.test(item.url),
      expires: expiresOf(item.url),
    })),
    handed_to_publisher: batch1Calls.map((call) => ({
      channel: call.channelId,
      urls: call.mediaUrls.map(redactUrl),
      shape_ok: call.mediaUrls.every((url) => SIGNED_MEDIA_URL.test(url)),
      expires: call.mediaUrls.map(expiresOf),
    })),
    // Different expiry = the link was minted again at publish time, not reused.
    resigned_before_publish: batch1Calls.every((call) =>
      call.mediaUrls.every((url) => {
        const stored = storedMedia.find((item) => url.includes(`/api/media/${item.driveFileId}?`));
        return Boolean(stored) && expiresOf(url) !== expiresOf(stored?.url ?? "");
      }),
    ),
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
  // The duplicate key now starts with the tenant id (gate note #3), so the batch
  // id sits in the middle — `includes`, not `startsWith`, or this proof would
  // pass vacuously.
  const batch4Calls = publisher.calls
    .slice(callsBeforeBlock)
    .filter((call) => call.idempotencyKey.includes(batch4));
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

  // --- Case i: batch summary of a PARTIAL batch (E7.5) ----------------------
  heading("i) get-batch-status: lô partial (1 kênh published, 1 kênh blocked)");
  const partialSummary = await getBatchStatus({ tenantId: DEMO_TENANT_ID, batchId: batch5 });
  print({
    batchId: partialSummary.batchId,
    status: partialSummary.status,
    totals: partialSummary.totals,
    startedAt: partialSummary.startedAt.toISOString(),
    finishedAt: partialSummary.finishedAt?.toISOString() ?? null,
    durationMs: partialSummary.durationMs,
    summaryMessage: partialSummary.summaryMessage,
    channels: partialSummary.channels.map((entry) => ({
      channel: entry.channelId,
      status: entry.status,
      attempts: entry.attemptCount,
      postId: entry.publishedPostId,
      url: entry.publishedUrl,
      errorCode: entry.lastErrorCode,
      userMessage: entry.userMessage,
    })),
  });

  // The blocked batch of case e must read "blocked", not "failed" (gate note #2).
  const blockedSummary = await getBatchStatus({ tenantId: DEMO_TENANT_ID, batchId: batch4 });
  print({
    batch4_status: blockedSummary.status,
    batch4_totals: blockedSummary.totals,
    batch4_message: blockedSummary.summaryMessage,
  });

  // A batch of another tenant / an unknown id must not leak into the summary.
  try {
    await getBatchStatus({ tenantId: DEMO_TENANT_ID, batchId: randomUUID() });
    console.log("!! expected BATCH_NOT_FOUND, got a summary");
  } catch (error) {
    const appError = AppError.from(error);
    print({ code: appError.code, userMessage: appError.userMessage, context: appError.context });
  }

  // --- Case j: retry a failed job -> it publishes ---------------------------
  heading("j) retry job failed -> chạy lại và published");
  publisher.setScenario(CHANNEL_A, { transientFailures: 99 });
  const batch7 = randomUUID();
  await usecases.createPostBatch({
    tenantId: DEMO_TENANT_ID,
    batchId: batch7,
    productCode: PRODUCT_A,
    color: "Tím",
    channelIds: [CHANNEL_A, CHANNEL_B],
    captionByChannel: captions,
    media: MEDIA,
  });
  await waitForBatch(db, batch7, ["published", "failed"], 60_000);
  const beforeRetry = await getBatchStatus({ tenantId: DEMO_TENANT_ID, batchId: batch7 });
  const failedJob = beforeRetry.channels.find((entry) => entry.status === "failed");
  if (!failedJob) throw new Error("case j: expected one failed channel");
  print({
    before_retry: {
      status: beforeRetry.status,
      channels: beforeRetry.channels.map((entry) => ({
        channel: entry.channelId,
        status: entry.status,
        attempts: entry.attemptCount,
        errorCode: entry.lastErrorCode,
        userMessage: entry.userMessage,
      })),
    },
  });

  // The channel works again; the operator presses "chạy lại".
  publisher.setScenario(CHANNEL_A, null);
  const retried = await retryPostJob({ tenantId: DEMO_TENANT_ID, postJobId: failedJob.postJobId });
  print({
    retried: {
      postJobId: retried.postJobId,
      previousStatus: retried.previousStatus,
      status: retried.status,
      queueJobId: retried.queueJobId,
      userMessage: retried.userMessage,
    },
  });
  await waitForBatch(db, batch7, ["published"], 60_000);
  const batch7CallsA = publisher.calls.filter(
    (call) => call.idempotencyKey.includes(batch7) && call.channelId === CHANNEL_A,
  );
  const firstExpiry = expiresOf(batch7CallsA[0]?.mediaUrls[0] ?? "");
  const retryExpiry = expiresOf(batch7CallsA[batch7CallsA.length - 1]?.mediaUrls[0] ?? "");
  print({
    media_url_on_retry: {
      channel_a_calls: batch7CallsA.length,
      first_attempt_expires: firstExpiry,
      retried_attempt_expires: retryExpiry,
      // TTL is 6h < the queue window a retry can span: a reused link would die.
      fresh_link_on_retry: Boolean(firstExpiry && retryExpiry && retryExpiry > firstExpiry),
      sample_url: redactUrl(batch7CallsA[batch7CallsA.length - 1]?.mediaUrls[0] ?? ""),
    },
  });
  const afterRetry = await getBatchStatus({ tenantId: DEMO_TENANT_ID, batchId: batch7 });
  print({
    after_retry: {
      status: afterRetry.status,
      channels: afterRetry.channels.map((entry) => ({
        channel: entry.channelId,
        status: entry.status,
        attempts: entry.attemptCount,
        postId: entry.publishedPostId,
        userMessage: entry.userMessage,
      })),
    },
  });

  // Retrying a job blocked by the stock gate still goes through the recheck:
  // the product is sold out again, so it must come back `blocked`, never live.
  await db.update(products).set({ stockRaw: "0" }).where(eq(products.code, PRODUCT_A));
  const blockedJob = (
    await db
      .select({ id: postJobs.id })
      .from(postJobs)
      .where(and(eq(postJobs.batchId, batch4), eq(postJobs.status, "blocked")))
  )[0];
  const callsBeforeStockRetry = publisher.callCount();
  await retryPostJob({ tenantId: DEMO_TENANT_ID, postJobId: blockedJob.id });
  await waitForBatch(db, batch4, ["blocked"], 60_000);
  const afterStockRetry = await repo.findJobById(DEMO_TENANT_ID, blockedJob.id);
  print({
    retry_of_a_stock_blocked_job: {
      status: afterStockRetry?.status,
      errorCode: afterStockRetry?.lastErrorCode,
      userMessage: afterStockRetry?.lastErrorMessage,
      publisher_calls_during_this_retry: publisher.callCount() - callsBeforeStockRetry,
      proof: publisher.callCount() === callsBeforeStockRetry ? "publisher NEVER called" : "LEAK",
    },
  });
  await db.update(products).set({ stockRaw: "104" }).where(eq(products.code, PRODUCT_A));

  // --- Case k: retry a published job ----------------------------------------
  heading("k) retry job published -> INVALID_JOB_TRANSITION (không đăng lần hai)");
  const publishedJob = (
    await db
      .select({ id: postJobs.id, postId: postJobs.publishedPostId })
      .from(postJobs)
      .where(and(eq(postJobs.batchId, batch1), eq(postJobs.status, "published")))
  )[0];
  const callsBeforeRefusedRetry = publisher.callCount();
  try {
    await retryPostJob({ tenantId: DEMO_TENANT_ID, postJobId: publishedJob.id });
    console.log("!! expected INVALID_JOB_TRANSITION, got success");
  } catch (error) {
    const appError = AppError.from(error);
    print({
      code: appError.code,
      userMessage: appError.userMessage,
      context: appError.context,
    });
  }
  const afterRefusedRetry = await repo.findJobById(DEMO_TENANT_ID, publishedJob.id);
  print({
    status_unchanged: afterRefusedRetry?.status,
    post_id_unchanged: afterRefusedRetry?.publishedPostId === publishedJob.postId,
    publisher_calls: publisher.callCount() - callsBeforeRefusedRetry,
  });

  // --- Job log (E11.1): newest first, with the reason column ----------------
  heading("E11.1) list-post-jobs: nhật ký job (mới nhất trước) + lọc + phân trang");
  const firstPage = await listPostJobs({ tenantId: DEMO_TENANT_ID, filter: { limit: 5 } });
  print({
    limit: firstPage.limit,
    nextCursor: firstPage.nextCursor,
    items: firstPage.items.map((entry) => ({
      channel: entry.channelId,
      product: entry.productCode,
      status: entry.status,
      attempts: entry.attemptCount,
      errorCode: entry.lastErrorCode,
      userMessage: entry.userMessage,
      canRetry: entry.canRetry,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
  const secondPage = await listPostJobs({
    tenantId: DEMO_TENANT_ID,
    filter: { limit: 5, cursor: firstPage.nextCursor },
  });
  print({
    page2_count: secondPage.items.length,
    page2_first: secondPage.items[0]?.postJobId ?? null,
    no_overlap_with_page1: secondPage.items.every(
      (entry) => !firstPage.items.some((first) => first.postJobId === entry.postJobId),
    ),
    blocked_only: (
      await listPostJobs({ tenantId: DEMO_TENANT_ID, filter: { status: "blocked" } })
    ).items.map((entry) => ({ channel: entry.channelId, userMessage: entry.userMessage })),
  });
  try {
    await listPostJobs({ tenantId: DEMO_TENANT_ID, filter: { status: "khong-ton-tai" } });
    console.log("!! expected INVALID_INPUT for an unknown status");
  } catch (error) {
    const appError = AppError.from(error);
    print({ code: appError.code, context: appError.context });
  }

  await consumer.close();

  // --- Case l: channel groups (E7.6) ----------------------------------------
  heading("l) channel-group CRUD + từ chối channel id lạ");
  const created = await groupUsecases.createChannelGroup({
    tenantId: DEMO_TENANT_ID,
    name: "  Toàn   bộ Page  ",
    channelIds: [CHANNEL_A, ` ${CHANNEL_B} `, CHANNEL_A],
  });
  print({ created });
  const updated = await groupUsecases.updateChannelGroup({
    tenantId: DEMO_TENANT_ID,
    groupId: created.id,
    name: "Chỉ Shop B",
    channelIds: [CHANNEL_B],
  });
  print({ updated, list: await groupUsecases.listChannelGroups({ tenantId: DEMO_TENANT_ID }) });

  for (const [label, call] of [
    [
      "channel id lạ",
      () =>
        groupUsecases.createChannelGroup({
          tenantId: DEMO_TENANT_ID,
          name: "Nhóm lạ",
          channelIds: [CHANNEL_A, "fbpage-khong-ton-tai"],
        }),
    ],
    [
      "nhóm rỗng",
      () =>
        groupUsecases.createChannelGroup({
          tenantId: DEMO_TENANT_ID,
          name: "Nhóm rỗng",
          channelIds: [],
        }),
    ],
    [
      "trùng tên",
      () =>
        groupUsecases.createChannelGroup({
          tenantId: DEMO_TENANT_ID,
          name: "Chỉ Shop B",
          channelIds: [CHANNEL_A],
        }),
    ],
  ] as Array<[string, () => Promise<unknown>]>) {
    try {
      await call();
      console.log(`!! expected INVALID_INPUT for: ${label}`);
    } catch (error) {
      const appError = AppError.from(error);
      print({ case: label, code: appError.code, userMessage: appError.userMessage });
    }
  }
  print({
    deleted: await groupUsecases.deleteChannelGroup({
      tenantId: DEMO_TENANT_ID,
      groupId: created.id,
    }),
    groups_left: (await groupUsecases.listChannelGroups({ tenantId: DEMO_TENANT_ID })).length,
  });

  // --- Case n: malformed uuid -> 400, not "database unreachable" -----------
  heading("n) uuid/enum rác qua repo thật -> INVALID_INPUT (22P02), không phải DB_ERROR");
  const badInputCases: Array<[string, () => Promise<unknown>]> = [
    ["postJobRepo.findJobById('khong-phai-uuid')", () => repo.findJobById(DEMO_TENANT_ID, "khong-phai-uuid")],
    ["postJobRepo.listJobsByBatch('lo-bay-gio')", () => repo.listJobsByBatch(DEMO_TENANT_ID, "lo-bay-gio")],
    ["postJobRepo.getBatchSummary('###')", () => repo.getBatchSummary(DEMO_TENANT_ID, "###")],
    ["channelGroupRepo.findGroupById('nhom-1')", () => groupRepo.findGroupById(DEMO_TENANT_ID, "nhom-1")],
    ["channelGroupRepo.deleteGroup('nhom-1')", () => groupRepo.deleteGroup(DEMO_TENANT_ID, "nhom-1")],
    ["retryPostJob(postJobId='abc')", () => retryPostJob({ tenantId: DEMO_TENANT_ID, postJobId: "abc" })],
    [
      "listPostJobs(cursor có id rác)",
      () =>
        listPostJobs({
          tenantId: DEMO_TENANT_ID,
          filter: { cursor: `${new Date().toISOString()}_khong-phai-uuid` },
        }),
    ],
  ];
  for (const [label, call] of badInputCases) {
    try {
      await call();
      console.log(`!! expected INVALID_INPUT for: ${label}`);
    } catch (error) {
      const appError = AppError.from(error);
      const ctx = appError.context as {
        pg_code?: string;
        field?: string;
        invalid_type?: string;
        operation?: string;
      };
      print({
        case: label,
        code: appError.code,
        http: appError.code === "INVALID_INPUT" ? 400 : 503,
        pg_code: ctx.pg_code ?? null,
        field: ctx.field ?? null,
        invalid_type: ctx.invalid_type ?? null,
        operation: ctx.operation ?? null,
        userMessage: appError.userMessage,
      });
    }
  }

  // --- Case o: audit actor (E11.1) -----------------------------------------
  heading("o) retry kèm actorEmail -> audit_log ghi đúng actor_user_id");
  const operatorId = randomUUID();
  await db
    .insert(users)
    .values({
      id: operatorId,
      tenantId: DEMO_TENANT_ID,
      email: "van@example.com",
      name: "Nguyen The Van",
      role: "owner",
    })
    .onConflictDoNothing();

  // Two blocked jobs to re-run (one per actor case): re-queueing a blocked job
  // is safe here — the consumer is closed, so nothing publishes behind our back.
  const auditJobs = await db
    .select({ id: postJobs.id })
    .from(postJobs)
    .where(and(eq(postJobs.batchId, batch4), eq(postJobs.status, "blocked")))
    .orderBy(postJobs.channelId);
  const auditJobId = auditJobs[0].id;
  const anonJobId = auditJobs[1].id;

  const auditedRetry = await retryPostJob({
    tenantId: DEMO_TENANT_ID,
    postJobId: auditJobId,
    // Mixed case + spaces: exactly what a Google session hands over.
    actorEmail: "  Van@Example.com ",
  });
  const auditRows = await db
    .select({
      action: auditLogs.action,
      entityId: auditLogs.entityId,
      actorUserId: auditLogs.actorUserId,
      payload: auditLogs.payload,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, auditJobId), eq(auditLogs.action, "post_job.queued")))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  print({
    retried_job: auditedRetry.postJobId,
    seeded_app_user_id: operatorId,
    audit_row: auditRows[0],
    actor_matches_app_user: auditRows[0]?.actorUserId === operatorId,
  });

  const unknownActor = await retryPostJob({
    tenantId: DEMO_TENANT_ID,
    postJobId: anonJobId,
    actorEmail: "khong-co-trong-app-user@example.com",
  });
  const anonRow = (
    await db
      .select({ actorUserId: auditLogs.actorUserId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, anonJobId), eq(auditLogs.action, "post_job.queued")))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)
  )[0];
  print({
    unknown_actor_still_retried: unknownActor.status,
    audit_actor_user_id: anonRow?.actorUserId ?? null,
  });

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
        // Repo-level test: the row is written directly, so the URL is signed here
        // (the usecase would do it) — the state machine is what this case proves.
        media: MEDIA.map((item) => ({
          driveFileId: item.driveFileId,
          fileName: item.fileName,
          url: usecases.signMediaUrl({
            tenantId: DEMO_TENANT_ID,
            assetId: item.driveFileId,
            baseUrl: mediaBaseUrl,
          }).url,
        })),
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
