import { vi } from "vitest";

import { deriveBatchStatus, type PostJob, type PostJobStatus } from "@/core/domain/post-job";
import type { Product } from "@/core/domain/product";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type { ApplyTransitionInput, PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelPublisher,
  SignMediaUrlFn,
} from "@/core/ports/publisher";
import { channelWriteStubs } from "@/core/usecases/__fixtures__/channel-config-repo";
import { makeMemoryJobProgressStore } from "@/core/usecases/__fixtures__/job-progress-store";
import { makeListPostJobs } from "@/core/usecases/list-post-jobs";
import { makePublishPost } from "@/core/usecases/publish-post";
import type { ReadMediaBytes } from "@/core/usecases/read-media-bytes";
import { makeRetryPostJob } from "@/core/usecases/retry-post-job";

import { makeFacebookPublisher } from "@/adapters/meta/facebook-publisher";
import { makeGraphClient } from "@/adapters/meta/graph-client";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The REAL Graph adapter wired into the REAL publish usecase, with only the HTTP
 * layer mocked — the one shape of test that catches a bug living in the seam
 * between what the adapter promises about a Graph answer and what the usecase
 * reads that promise as.
 *
 * Shared by the handoff (E8.6) and the immediate-publish duplicate regressions
 * on purpose: both ask the same question of the same wiring, and two copies of
 * this repo's optimistic-write semantics would let the two answers drift.
 */

export const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
export const NOW = Date.parse("2026-08-13T02:00:00.000Z");
/** Inside the handoff window (T-30..T-12), so a handoff is what runs. */
export const SCHEDULED_AT = new Date(NOW + 20 * 60_000);

export const CHANNEL: ChannelConfig = {
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: "EAAsecret-token",
  status: "active",
  tokenExpiresAt: null,
};

export const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

export function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

export function fixedClock(): Clock {
  return { now: () => new Date(NOW), nowMs: () => NOW };
}

export function makeJob(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: "job-1",
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: null,
    captionText: "Giannal – MỘT NGÀY DỊU DÀNG",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: SCHEDULED_AT,
    queueJobId: "pp.job-1",
    ...overrides,
  };
}

/** Same optimistic guard as the Drizzle repo: an UPDATE ... WHERE status = from. */
export function makeMemoryRepo(job: PostJob) {
  const store = new Map<string, PostJob>([[job.id, job]]);
  const repo: PostJobRepo & { get(id: string): PostJob | undefined; force(next: PostJob): void } = {
    get: (id) => store.get(id),
    force: (next) => store.set(next.id, next),
    async createBatchWithJobs() {
      throw new Error("not used in this test");
    },
    async findJobById(_tenantId: string, postJobId: string) {
      return store.get(postJobId) ?? null;
    },
    async listJobsByBatch(_tenantId: string, batchId: string) {
      return [...store.values()].filter((entry) => entry.batchId === batchId);
    },
    async listJobs() {
      // Enough for the job log to render this one row: the "Chạy lại" button is
      // decided there, and it is half of every fix these files check.
      return {
        items: [...store.values()].map((entry) => ({
          ...entry,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        })),
        nextCursor: null,
      };
    },
    async applyTransition(input: ApplyTransitionInput) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
      return input.next;
    },
    async setQueueJobId(input) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== "queued") return false;
      store.set(input.postJobId, { ...current, queueJobId: input.queueJobId });
      return true;
    },
    async rescheduleJob() {
      return null;
    },
    async listScheduledJobs() {
      return { items: [], nextCursor: null };
    },
    async findStalePublishing() {
      return [];
    },
    async findOverdueQueued() {
      return [];
    },
    async findScheduledOnPlatformDue() {
      return [];
    },
    async findLastPublishedAt() {
      return null;
    },
    async findBatchSpacingMs() {
      // No per-run gap: the tenant setting applies, as it always did.
      return null;
    },
    async refreshBatchStatus(_tenantId: string, batchId: string): Promise<PostBatchSummary> {
      const list = [...store.values()].filter((entry) => entry.batchId === batchId);
      const byStatus = {
        draft: 0,
        queued: 0,
        publishing: 0,
        scheduled_on_facebook: 0,
        published: 0,
        failed: 0,
        blocked: 0,
      } as Record<PostJobStatus, number>;
      return {
        batchId,
        tenantId: TENANT,
        productCode: list[0]?.productCode ?? "",
        status: deriveBatchStatus(list.map((entry) => entry.status)),
        total: list.length,
        byStatus,
        startedAt: new Date(NOW),
        finishedAt: null,
        jobs: list,
      };
    },
    async getBatchSummary() {
      return null;
    },
    // E7.5 progress milestones: not what this file is about, but the port
    // requires the method, and a fake that throws would hide a real regression.
    async appendJobEvent() {},
  };
  return repo;
}

export function makeProducts(): ProductRepo {
  const product: Product = {
    content: { code: "MGKVX6310", name: "Giannal", description: null, category: null, season: null },
    operational: { stockRaw: "104", noteRaw: "", colorsRaw: "TÍM" },
    hasConflict: false,
    sourceRows: [2],
  };
  return {
    findByCode: async () => product,
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 1,
  };
}

export function makeChannels(channel: ChannelConfig = CHANNEL): ChannelConfigRepo {
  return {
    findChannel: async () => channel,
    listChannels: async () => [channel],
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
    ...channelWriteStubs(),
  };
}

export function makeQueue() {
  const enqueued: Array<{ name: string; payload: unknown; opts?: EnqueueOptions }> = [];
  const queue: JobQueue & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(name, payload, opts) {
      enqueued.push({ name, payload, opts });
      return { jobId: opts?.jobId ?? "generated" };
    },
    async remove() {
      return true;
    },
    async has() {
      return true;
    },
    async enqueueRepeatable() {
      return { jobId: "repeatable" };
    },
    async close() {},
  };
  return queue;
}

export const signMediaUrl: SignMediaUrlFn = (input) => ({
  url: `${input.baseUrl}/api/media/${input.assetId}`,
  path: `/api/media/${input.assetId}`,
  expiresAtMs: NOW + 6 * 60 * 60 * 1000,
  signature: "deadbeef",
});

export function harness(
  fetchImpl: typeof fetch,
  job: PostJob = makeJob(),
  /**
   * For the TikTok half of the same invariant: another channel to resolve, and
   * the REAL publisher for its platform, built on the same mocked `fetch`.
   */
  options: {
    channel?: ChannelConfig;
    publishers?: Partial<Record<ChannelPlatform, ChannelPublisher>>;
  } = {},
) {
  const logger = silentLogger();
  const repo = makeMemoryRepo(job);
  const queue = makeQueue();
  const readMediaBytes = vi.fn<ReadMediaBytes>(async () => ({
    bytes: PHOTO_BYTES,
    mimeType: "image/jpeg",
  }));
  const facebook = makeFacebookPublisher({
    graph: makeGraphClient({ logger, fetchImpl, version: "v23.0" }),
    logger,
  });
  const channels = makeChannels(options.channel ?? CHANNEL);
  const clock = fixedClock();
  const progress = makeMemoryJobProgressStore();
  const publish = makePublishPost({
    postJobs: repo,
    products: makeProducts(),
    channels,
    // Doc 10 §5.2 — active tenant, so these boundary tests keep exercising the
    // Graph half rather than the suspension gate.
    tenants: { findById: async () => ({ id: TENANT, name: "Demo", status: "active" }) },
    publishers: { facebook, ...(options.publishers ?? {}) },
    queue,
    progress,
    clock,
    logger,
    signMediaUrl,
    mediaBaseUrl: () => "https://mysp.example.com",
    readMediaBytes,
  });
  // The operator's button and the screen that draws it, on the SAME repo the
  // worker uses: these three must agree.
  const retry = makeRetryPostJob({ postJobs: repo, channels, queue, clock, logger });
  const listJobs = makeListPostJobs({ postJobs: repo, logger });
  return { publish, retry, listJobs, repo, queue, readMediaBytes, progress };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
