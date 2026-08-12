import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import { deriveBatchStatus, type PostJob, type PostJobMedia } from "@/core/domain/post-job";
import type { Product } from "@/core/domain/product";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type { NewPostJob, PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type { ChannelConfig, ChannelConfigRepo } from "@/core/ports/publisher";

import { makeCreatePostBatch } from "./create-post-batch";

const TENANT = "00000000-0000-0000-0000-000000000001";

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

const CLOCK: Clock = {
  now: () => new Date("2026-08-13T02:00:00.000Z"),
  nowMs: () => Date.parse("2026-08-13T02:00:00.000Z"),
};

const MEDIA: PostJobMedia[] = [
  { driveFileId: "d1", fileName: "MGKVX6310-Tím (1).jpg", url: "https://cdn.example/1.jpg" },
  { driveFileId: "d2", fileName: "MGKVX6310-Tím (2).jpg", url: "https://cdn.example/2.jpg" },
];

function makeProduct(stockRaw = "104", noteRaw = ""): Product {
  return {
    content: { code: "MGKVX6310", name: "Giannal", description: null, category: null, season: null },
    operational: { stockRaw, noteRaw, colorsRaw: "TÍM" },
    hasConflict: false,
    sourceRows: [2],
  };
}

function channel(channelId: string, status: "active" | "disabled" = "active"): ChannelConfig {
  return {
    channelId,
    platform: "facebook",
    name: channelId,
    externalId: `page-${channelId}`,
    accessToken: "secret",
    status,
    tokenExpiresAt: null,
  };
}

function makeRepo(options: { failCreate?: AppError } = {}) {
  const store = new Map<string, PostJob>();
  const repo: PostJobRepo & { store: typeof store } = {
    store,
    async createBatchWithJobs(input: { batch: { id: string }; jobs: readonly NewPostJob[] }) {
      if (options.failCreate) throw options.failCreate;
      const jobs = input.jobs.map((job) => {
        const created: PostJob = {
          id: job.id,
          tenantId: job.tenantId,
          batchId: job.batchId,
          productCode: job.productCode,
          color: job.color,
          channelId: job.channelId,
          format: job.format,
          status: "draft",
          attemptCount: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
          captionText: job.captionText,
          media: job.media,
          scheduledAt: job.scheduledAt,
        };
        store.set(created.id, created);
        return created;
      });
      return { batchId: input.batch.id, jobs };
    },
    async findJobById(_tenantId, postJobId) {
      return store.get(postJobId) ?? null;
    },
    async listJobsByBatch(_tenantId, batchId) {
      return [...store.values()].filter((job) => job.batchId === batchId);
    },
    async applyTransition(input) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
      return input.next;
    },
    async findLastPublishedAt() {
      return null;
    },
    async refreshBatchStatus(_tenantId, batchId): Promise<PostBatchSummary> {
      const jobs = [...store.values()].filter((job) => job.batchId === batchId);
      return {
        batchId,
        tenantId: TENANT,
        productCode: jobs[0]?.productCode ?? "",
        status: deriveBatchStatus(jobs.map((job) => job.status)),
        total: jobs.length,
        byStatus: { draft: 0, queued: 0, publishing: 0, published: 0, failed: 0, blocked: 0 },
        jobs,
      };
    },
    async getBatchSummary() {
      return null;
    },
  };
  return repo;
}

function makeQueue(options: { failFor?: string } = {}) {
  const enqueued: Array<{ payload: { postJobId: string }; opts?: EnqueueOptions }> = [];
  const queue: JobQueue & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(_jobName, payload, opts) {
      const typed = payload as { postJobId: string };
      if (options.failFor && opts?.jobId?.includes(options.failFor)) {
        throw new AppError("QUEUE_ERROR", { message: "redis down" });
      }
      enqueued.push({ payload: typed, opts });
      return { jobId: opts?.jobId ?? "generated" };
    },
    async close() {},
  };
  return queue;
}

function harness(options: {
  product?: Product | null;
  channels?: ChannelConfig[];
  repo?: ReturnType<typeof makeRepo>;
  queue?: ReturnType<typeof makeQueue>;
} = {}) {
  const lines: LogLine[] = [];
  const repo = options.repo ?? makeRepo();
  const queue = options.queue ?? makeQueue();
  const known = options.channels ?? [channel("fbpage-a"), channel("fbpage-b")];
  const products: ProductRepo = {
    findByCode: async () => (options.product === undefined ? makeProduct() : options.product),
    upsertMany: async () => 0,
    deleteStale: async () => 0,
  };
  const channels: ChannelConfigRepo = {
    findChannel: async (_tenantId, channelId) =>
      known.find((entry) => entry.channelId === channelId) ?? null,
    listChannels: async () => known,
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
  };
  let counter = 0;
  const createPostBatch = makeCreatePostBatch({
    postJobs: repo,
    products,
    channels,
    queue,
    clock: CLOCK,
    logger: recordingLogger(lines),
    newId: () => `id-${++counter}`,
  });
  return { createPostBatch, repo, queue, lines };
}

const BASE_INPUT = {
  tenantId: TENANT,
  batchId: "batch-1",
  productCode: "mgkvx6310",
  color: "Tím",
  channelIds: ["fbpage-a", "fbpage-b"],
  captionByChannel: {
    "fbpage-a": "Giannal – NẮNG THÁNG TÁM",
    "fbpage-b": "Giannal – MỘT NGÀY DỊU DÀNG",
  },
  media: MEDIA,
};

// --- Edge cases first -------------------------------------------------------

describe("createPostBatch — rejected calls", () => {
  it.each([
    ["a malformed tenant id", { tenantId: "nope" }],
    ["an empty product code", { productCode: "  " }],
    ["no channel", { channelIds: [] }],
    ["no media", { media: [] }],
    ["11 photos", { media: Array.from({ length: 11 }, () => MEDIA[0]) }],
    ["a Phase 2 format", { format: "video_post" as const }],
  ])("rejects %s", async (_label, patch) => {
    const { createPostBatch, queue } = harness();
    await expect(createPostBatch({ ...BASE_INPUT, ...patch })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("rejects media without a public http(s) URL (Facebook fetches it itself)", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({
        ...BASE_INPUT,
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "drive://file/d" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { media_index: 0 } });
  });

  it("rejects a channel without its own caption (brief §7.2)", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({
        ...BASE_INPUT,
        captionByChannel: { "fbpage-a": "chỉ có một caption" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { channels_without_caption: ["fbpage-b"] },
    });
  });

  it("raises PRODUCT_NOT_FOUND before creating anything", async () => {
    const { createPostBatch, repo, queue } = harness({ product: null });
    await expect(createPostBatch(BASE_INPUT)).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    expect(repo.store.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("propagates DUPLICATE_POST_BLOCKED from the unique index (business rule 4)", async () => {
    const repo = makeRepo({
      failCreate: new AppError("DUPLICATE_POST_BLOCKED", { message: "unique violation" }),
    });
    const { createPostBatch, queue } = harness({ repo });
    await expect(createPostBatch(BASE_INPUT)).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
    });
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe("createPostBatch — stock gate runs first (business rule 1)", () => {
  it("blocks every channel and queues nothing when the code is sold out", async () => {
    const { createPostBatch, repo, queue } = harness({ product: makeProduct("0") });

    const result = await createPostBatch(BASE_INPUT);

    expect(queue.enqueued).toHaveLength(0);
    expect(result.batchStatus).toBe("failed");
    expect(result.channels.map((entry) => entry.errorCode)).toEqual([
      "OUT_OF_STOCK",
      "OUT_OF_STOCK",
    ]);
    for (const job of repo.store.values()) {
      expect(job.status).toBe("blocked");
      expect(job.lastErrorCode).toBe("OUT_OF_STOCK");
    }
  });

  it("keeps the low-stock warning internal but still queues the posts", async () => {
    const { createPostBatch, queue } = harness({ product: makeProduct("3") });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.warnings.join(" ")).toContain("Tồn thấp 3c");
    expect(queue.enqueued).toHaveLength(2);
  });
});

describe("createPostBatch — fan-out (business rule 6)", () => {
  it("creates one queued job per channel with its own caption", async () => {
    const { createPostBatch, repo, queue } = harness();

    const result = await createPostBatch(BASE_INPUT);

    expect(result.batchStatus).toBe("running");
    expect(result.channels).toHaveLength(2);
    expect(result.channels.every((entry) => entry.queued)).toBe(true);
    expect(queue.enqueued).toHaveLength(2);
    // Distinct queue ids, or one of the two posts would never run.
    expect(new Set(queue.enqueued.map((entry) => entry.opts?.jobId)).size).toBe(2);
    expect(queue.enqueued[0].opts?.attempts).toBe(3);
    expect(queue.enqueued[0].opts?.backoff).toEqual({ strategy: "exponential", delayMs: 1_000 });

    const jobs = [...repo.store.values()];
    expect(jobs.map((job) => job.status)).toEqual(["queued", "queued"]);
    expect(jobs.map((job) => job.captionText)).toEqual([
      "Giannal – NẮNG THÁNG TÁM",
      "Giannal – MỘT NGÀY DỊU DÀNG",
    ]);
    // Product code and colour normalised — the unique key must be stable.
    expect(jobs.every((job) => job.productCode === "MGKVX6310" && job.color === "TÍM")).toBe(true);
  });

  it("blocks only the unconfigured channel; the other one still goes out", async () => {
    const { createPostBatch, repo, queue } = harness({ channels: [channel("fbpage-a")] });

    const result = await createPostBatch(BASE_INPUT);

    expect(result.batchStatus).toBe("running");
    expect(result.channels).toEqual([
      expect.objectContaining({ channelId: "fbpage-a", queued: true, errorCode: null }),
      expect.objectContaining({
        channelId: "fbpage-b",
        queued: false,
        errorCode: "CHANNEL_NOT_CONFIGURED",
      }),
    ]);
    expect(queue.enqueued).toHaveLength(1);
    expect([...repo.store.values()].map((job) => job.status)).toEqual(["queued", "blocked"]);
  });

  it("treats a disabled channel as not configured", async () => {
    const { createPostBatch } = harness({
      channels: [channel("fbpage-a"), channel("fbpage-b", "disabled")],
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.channels[1].errorCode).toBe("CHANNEL_NOT_CONFIGURED");
  });

  it("isolates a queue failure to its own channel", async () => {
    const queue = makeQueue({ failFor: "fbpage-b" });
    const { createPostBatch, repo } = harness({ queue });

    const result = await createPostBatch(BASE_INPUT);

    expect(result.channels[0]).toMatchObject({ channelId: "fbpage-a", queued: true });
    expect(result.channels[1]).toMatchObject({
      channelId: "fbpage-b",
      queued: false,
      errorCode: "QUEUE_ERROR",
      status: "failed",
    });
    expect([...repo.store.values()].map((job) => job.status)).toEqual(["queued", "failed"]);
  });

  it("writes the row as `queued` BEFORE enqueueing (a worker must never see `draft`)", async () => {
    const order: string[] = [];
    const repo = makeRepo();
    const original = repo.applyTransition.bind(repo);
    repo.applyTransition = async (input) => {
      order.push(`db:${input.next.status}:${input.next.channelId}`);
      return original(input);
    };
    const queue = makeQueue();
    const originalEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (name, payload, opts) => {
      order.push(`queue:${(payload as { postJobId: string }).postJobId}`);
      return originalEnqueue(name, payload, opts);
    };

    await harness({ repo, queue }).createPostBatch(BASE_INPUT);

    expect(order).toEqual([
      "db:queued:fbpage-a",
      "queue:id-1",
      "db:queued:fbpage-b",
      "queue:id-2",
    ]);
  });

  it("warns when two channels received the same caption (brief §7.2)", async () => {
    const { createPostBatch, lines } = harness();
    await createPostBatch({
      ...BASE_INPUT,
      captionByChannel: { "fbpage-a": "cùng một caption", "fbpage-b": "cùng một caption" },
    });
    expect(lines.some((line) => line.level === "warn" && line.message.includes("identical caption"))).toBe(
      true,
    );
  });

  it("delays the queue job when the post is scheduled for later", async () => {
    const { createPostBatch, queue } = harness();
    await createPostBatch({
      ...BASE_INPUT,
      scheduledAt: new Date("2026-08-13T03:00:00.000Z"),
    });
    expect(queue.enqueued[0].opts?.delayMs).toBe(3_600_000);
  });

  it("generates a batch id when the caller does not supply one", async () => {
    const { createPostBatch } = harness();
    const result = await createPostBatch({ ...BASE_INPUT, batchId: undefined });
    expect(result.batchId).toBe("id-1");
  });

  it("passes {tenantId, postJobId} as the queue payload — nothing else", async () => {
    const { createPostBatch, queue } = harness();
    const result = await createPostBatch(BASE_INPUT);
    expect(queue.enqueued[0].payload).toEqual({
      tenantId: TENANT,
      postJobId: result.channels[0].postJobId,
    });
  });
});

describe("createPostBatch — logging", () => {
  it("logs the anti-duplicate keys so 'why is this post not live?' is answerable", async () => {
    const { createPostBatch, lines } = harness();
    await createPostBatch(BASE_INPUT);

    const created = lines.find((line) => line.message === "Post batch created");
    expect(created?.context).toMatchObject({
      duplicate_keys: [
        "batch-1|MGKVX6310|TÍM|fbpage-a|image_post",
        "batch-1|MGKVX6310|TÍM|fbpage-b|image_post",
      ],
      job_count: 2,
      media_count: 2,
    });
  });

  it("logs the block reason of every channel it stops", async () => {
    const { createPostBatch, lines } = harness({ channels: [channel("fbpage-a")] });
    await createPostBatch(BASE_INPUT);

    const blocked = lines.find((line) =>
      line.message.includes("Channel blocked at fan-out"),
    );
    expect(blocked?.level).toBe("warn");
    expect(blocked?.context).toMatchObject({ error_code: "CHANNEL_NOT_CONFIGURED" });
  });
});
