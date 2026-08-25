import { describe, expect, it } from "vitest";

import { MYSP_FIELD_MAP, type StockPolicy } from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import {
  deriveBatchStatus,
  HANDOFF_WINDOW_START_MS,
  type PostJob,
} from "@/core/domain/post-job";
import type { Product } from "@/core/domain/product";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type { NewPostJob, PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  SignMediaUrlFn,
} from "@/core/ports/publisher";

import { channelWriteStubs } from "./__fixtures__/channel-config-repo";
import { makeCreatePostBatch, type PostMediaInput } from "./create-post-batch";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

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

/** Callers hand over ASSETS; the usecase mints the URL (E3.6). */
const MEDIA: PostMediaInput[] = [
  { driveFileId: "d1", fileName: "MGKVX6310-Tím (1).jpg", kind: "image" },
  { driveFileId: "d2", fileName: "MGKVX6310-Tím (2).jpg", kind: "image" },
];

const MEDIA_BASE_URL = "https://mysp.example.com";

/** Deterministic stand-in for the HMAC signer wired in composition. */
function fakeSigner(nowMs = CLOCK.nowMs()) {
  const calls: Array<{ tenantId: string; assetId: string; baseUrl: string }> = [];
  const sign: SignMediaUrlFn = (input) => {
    calls.push({ tenantId: input.tenantId, assetId: input.assetId, baseUrl: input.baseUrl });
    const expiresAtMs = nowMs + (input.ttlMs ?? 6 * 60 * 60 * 1000);
    const path = `/api/media/${input.assetId}?tenant=${input.tenantId}&expires=${expiresAtMs}&sig=deadbeef`;
    return { url: `${input.baseUrl}${path}`, path, expiresAtMs, signature: "deadbeef" };
  };
  return { sign, calls };
}

/**
 * Config repo answering only the hot-path read this usecase makes. Full port
 * shape so the fake cannot drift away from `CatalogConfigRepo`.
 */
function makeCatalogConfig(policy: StockPolicy | Error): CatalogConfigRepo {
  return {
    findCatalogConfig: async () => null,
    findCatalogSource: async () => null,
    findFieldMap: async () => MYSP_FIELD_MAP,
    findStockPolicy: async () => {
      if (policy instanceof Error) throw policy;
      return policy;
    },
    saveCatalogSource: async () => ({ previous: null }),
  };
}

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
          productOrigin: job.productOrigin,
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
          scheduledPostId: null,
          captionText: job.captionText,
          media: job.media,
          scheduledAt: job.scheduledAt,
          queueJobId: null,
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
    async listJobs() {
      // Not exercised here: the job log has its own test (list-post-jobs).
      return { items: [], nextCursor: null };
    },
    async applyTransition(input) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
      return input.next;
    },
    async setQueueJobId() {
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
    async refreshBatchStatus(_tenantId, batchId): Promise<PostBatchSummary> {
      const jobs = [...store.values()].filter((job) => job.batchId === batchId);
      return {
        batchId,
        tenantId: TENANT,
        productCode: jobs[0]?.productCode ?? "",
        status: deriveBatchStatus(jobs.map((job) => job.status)),
        total: jobs.length,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 0,
          published: 0,
          failed: 0,
          blocked: 0,
        },
        startedAt: CLOCK.now(),
        finishedAt: null,
        jobs,
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

function harness(options: {
  product?: Product | null;
  channels?: ChannelConfig[];
  repo?: ReturnType<typeof makeRepo>;
  queue?: ReturnType<typeof makeQueue>;
  signMediaUrl?: SignMediaUrlFn;
  mediaBaseUrl?: () => string;
  /** Onboarding phase 1 — the tenant's stock policy, or the read that fails. */
  stockPolicy?: StockPolicy | Error;
} = {}) {
  const lines: LogLine[] = [];
  const repo = options.repo ?? makeRepo();
  const queue = options.queue ?? makeQueue();
  const known = options.channels ?? [channel("fbpage-a"), channel("fbpage-b")];
  const products: ProductRepo = {
    findByCode: async () => (options.product === undefined ? makeProduct() : options.product),
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 0,
  };
  const channels: ChannelConfigRepo = {
    findChannel: async (_tenantId, channelId) =>
      known.find((entry) => entry.channelId === channelId) ?? null,
    listChannels: async () => known,
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
    ...channelWriteStubs(),
  };
  let counter = 0;
  const signer = fakeSigner();
  const createPostBatch = makeCreatePostBatch({
    postJobs: repo,
    products,
    channels,
    queue,
    clock: CLOCK,
    logger: recordingLogger(lines),
    newId: () => `id-${++counter}`,
    signMediaUrl: options.signMediaUrl ?? signer.sign,
    mediaBaseUrl: options.mediaBaseUrl ?? (() => MEDIA_BASE_URL),
    ...(options.stockPolicy === undefined
      ? {}
      : { catalogConfig: makeCatalogConfig(options.stockPolicy) }),
  });
  return { createPostBatch, repo, queue, lines, signer };
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
    ["a malformed tenant id", { tenantId: testTenantId("nope") }],
    ["an empty product code", { productCode: "  " }],
    ["no channel", { channelIds: [] }],
    ["no media", { media: [] }],
    ["11 photos", { media: Array.from({ length: 11 }, () => MEDIA[0]) }],
  ])("rejects %s", async (_label, patch) => {
    const { createPostBatch, queue } = harness();
    await expect(createPostBatch({ ...BASE_INPUT, ...patch })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("rejects a media item without a driveFileId (nothing to sign, now or later)", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({ ...BASE_INPUT, media: [{ driveFileId: "  ", fileName: "f.jpg" }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { media_index: 0 } });
  });

  it("rejects the same photo twice in one album", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({ ...BASE_INPUT, media: [MEDIA[0], { driveFileId: "d1" }] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { media_index: 1, drive_file_id: "d1" },
    });
  });

  it("rejects a video item — Phase 1 publishes images only", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({
        ...BASE_INPUT,
        media: [{ driveFileId: "d1", fileName: "clip.mp4", kind: "video" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { kind: "video" } });
  });

  it("fails the WHOLE batch when the signer is misconfigured (no half album)", async () => {
    const { createPostBatch, repo, queue } = harness({
      mediaBaseUrl: () => {
        throw new AppError("INVALID_INPUT", { message: "MEDIA_PUBLIC_BASE_URL is missing" });
      },
    });
    await expect(createPostBatch(BASE_INPUT)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "MEDIA_BASE_URL_UNAVAILABLE", hint: "MEDIA_PUBLIC_BASE_URL" },
    });
    expect(repo.store.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("fails the batch when signing one photo throws", async () => {
    const { createPostBatch, repo } = harness({
      signMediaUrl: (input) => {
        if (input.assetId === "d2") throw new AppError("INVALID_INPUT", { message: "bad asset id" });
        return {
          url: `${input.baseUrl}/api/media/${input.assetId}`,
          path: `/api/media/${input.assetId}`,
          expiresAtMs: 1,
          signature: "x",
        };
      },
    });
    await expect(createPostBatch(BASE_INPUT)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "MEDIA_URL_SIGNING_FAILED", media_index: 1, drive_file_id: "d2" },
    });
    expect(repo.store.size).toBe(0);
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
    // Gate note #2: every job stopped by the stock rule -> "blocked", not "failed".
    expect(result.batchStatus).toBe("blocked");
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

/**
 * Onboarding phase 1 — the tenant's StockPolicy reaching the FIRST stock check
 * (the one that decides whether a batch is queued at all). Edge cases first.
 */
const TEXTUAL_POLICY: StockPolicy = {
  mode: "textual",
  inStockValues: ["Còn hàng", "Sẵn hàng"],
  outOfStockValues: ["Hết hàng"],
};
const DISABLED_POLICY: StockPolicy = {
  mode: "disabled",
  reason: "Khách quản lý tồn kho trên phần mềm riêng",
};

describe("createPostBatch — tenant stock policy (onboarding phase 1)", () => {
  it("creates and queues NOTHING when the stored policy cannot be read", async () => {
    const { createPostBatch, repo, queue, lines } = harness({
      stockPolicy: new AppError("SYNC_FAILED", { message: "invalid stockPolicy" }),
    });

    await expect(createPostBatch(BASE_INPUT)).rejects.toMatchObject({ code: "SYNC_FAILED" });
    // Read before the insert: no half-created batch to explain afterwards.
    expect(repo.store.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
    expect(
      lines.some(
        (line) => line.level === "error" && line.context?.reason === "STOCK_POLICY_UNREADABLE",
      ),
    ).toBe(true);
  });

  it("keeps the numeric behaviour when no config repo is wired", async () => {
    const { createPostBatch, queue } = harness({ product: makeProduct("0") });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("numeric mode is unchanged when the repo answers the default", async () => {
    const { createPostBatch, queue } = harness({
      product: makeProduct("0"),
      stockPolicy: { mode: "numeric" },
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("textual: queues a declared in-stock wording that numeric mode would block", async () => {
    const { createPostBatch, queue } = harness({
      product: makeProduct("Còn hàng"),
      stockPolicy: TEXTUAL_POLICY,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.channels.map((entry) => entry.status)).toEqual(["queued", "queued"]);
    expect(queue.enqueued).toHaveLength(2);
  });

  it("textual: blocks a declared out-of-stock wording", async () => {
    const { createPostBatch, queue } = harness({
      product: makeProduct("Hết hàng"),
      stockPolicy: TEXTUAL_POLICY,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(result.channels.map((entry) => entry.errorCode)).toEqual([
      "OUT_OF_STOCK",
      "OUT_OF_STOCK",
    ]);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("textual: blocks a wording the tenant never declared — no guessing", async () => {
    const { createPostBatch, queue, lines } = harness({
      product: makeProduct("sắp về"),
      stockPolicy: TEXTUAL_POLICY,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
    expect(
      lines.some(
        (line) =>
          line.context?.reason === "STOCK_TEXT_UNKNOWN" &&
          line.context?.stock_policy_mode === "textual",
      ),
    ).toBe(true);
  });

  it("disabled: queues an empty stock cell and says NOBODY checked", async () => {
    const { createPostBatch, queue, lines } = harness({
      product: makeProduct(""),
      stockPolicy: DISABLED_POLICY,
    });

    const result = await createPostBatch(BASE_INPUT);

    expect(result.channels.map((entry) => entry.status)).toEqual(["queued", "queued"]);
    expect(queue.enqueued).toHaveLength(2);
    // The operator sees it on the screen...
    expect(result.warnings.join(" ")).toContain("tắt kiểm tồn kho");
    // ...the batch record carries it...
    expect(lines.find((line) => line.message === "Post batch created")?.context).toMatchObject({
      stock_policy_mode: "disabled",
      stock_check_skipped: true,
    });
    // ...and a WARN line answers "vì sao bài này lên dù hết hàng" on its own.
    const skipped = lines.find(
      (line) => line.level === "warn" && line.context?.stock_check_skipped === true,
    );
    expect(skipped).toBeDefined();
    expect(skipped?.context).toMatchObject({
      stock_policy_mode: "disabled",
      stock_check_skipped_reason: "Khách quản lý tồn kho trên phần mềm riêng",
    });
  });

  it("disabled: 'HẾT HÀNG' in the note still blocks the whole batch", async () => {
    const { createPostBatch, repo, queue } = harness({
      product: makeProduct("50", "HẾT HÀNG"),
      stockPolicy: DISABLED_POLICY,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
    for (const job of repo.store.values()) expect(job.lastErrorCode).toBe("OUT_OF_STOCK");
  });

  it("disabled: conflicting sheet rows still block", async () => {
    const conflicting: Product = { ...makeProduct("104"), hasConflict: true };
    const { createPostBatch, queue } = harness({
      product: conflicting,
      stockPolicy: DISABLED_POLICY,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("a policy that itself is invalid blocks instead of queueing unchecked", async () => {
    // Hand-edited row shape: `disabled` without the required written reason.
    const { createPostBatch, queue } = harness({
      product: makeProduct("104"),
      stockPolicy: { mode: "disabled", reason: "" } as StockPolicy,
    });
    const result = await createPostBatch(BASE_INPUT);
    expect(result.batchStatus).toBe("blocked");
    expect(queue.enqueued).toHaveLength(0);
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

  it("publishes the album in the order the caller gave, cover first", async () => {
    // The contract the wizard's drag-to-reorder rests on: the operator's
    // arrangement lives in the POST, and nothing here re-sorts it. Sorting by
    // file name or sequence would silently discard what they arranged.
    const { createPostBatch, repo } = harness();

    const arranged: PostMediaInput[] = [
      { driveFileId: "d9", fileName: "MGKVX6310-Tím (9).jpg", kind: "image" },
      { driveFileId: "d1", fileName: "MGKVX6310-Tím (1).jpg", kind: "image" },
      { driveFileId: "d5", fileName: "MGKVX6310-Tím (5).jpg", kind: "image" },
    ];

    await createPostBatch({ ...BASE_INPUT, media: arranged });

    for (const job of repo.store.values()) {
      expect(job.media.map((item) => item.driveFileId)).toEqual(["d9", "d1", "d5"]);
    }
  });

  it("mints one signed URL per photo and stores it on every job (E3.6)", async () => {
    const { createPostBatch, repo, signer, lines } = harness();

    await createPostBatch(BASE_INPUT);

    // One signature per asset per batch — the same URLs land on both channels.
    expect(signer.calls).toEqual([
      { tenantId: TENANT, assetId: "d1", baseUrl: MEDIA_BASE_URL },
      { tenantId: TENANT, assetId: "d2", baseUrl: MEDIA_BASE_URL },
    ]);
    for (const job of repo.store.values()) {
      expect(job.media).toHaveLength(2);
      for (const item of job.media) {
        expect(item.url).toMatch(
          /^https:\/\/mysp\.example\.com\/api\/media\/[^?]+\?tenant=[^&]+&expires=\d+&sig=\w+$/,
        );
        expect(item.driveFileId).not.toBe("");
      }
    }
    // The log carries the expiry, never the signed URL itself.
    const created = lines.find((line) => line.message === "Post batch created");
    expect(created?.context).toMatchObject({ media_count: 2 });
    expect(String(created?.context?.media_url_expires_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(created?.context)).not.toContain("sig=");
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

  it("wakes the queue job at the start of the handoff window, not at the hour", async () => {
    const { createPostBatch, queue } = harness();
    await createPostBatch({
      ...BASE_INPUT,
      scheduledAt: new Date("2026-08-13T03:00:00.000Z"),
    });
    // E8.6: T is one hour away, so the worker wakes at T-30 and hands the post
    // to Facebook there — waiting the full hour would leave nothing to hand.
    expect(queue.enqueued[0].opts?.delayMs).toBe(3_600_000 - HANDOFF_WINDOW_START_MS);
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
        `${TENANT}|batch-1|MGKVX6310|TÍM|fbpage-a|image_post`,
        `${TENANT}|batch-1|MGKVX6310|TÍM|fbpage-b|image_post`,
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

describe("createPostBatch — scheduling (E8.1)", () => {
  const IN_ONE_HOUR = new Date(Date.parse("2026-08-13T03:00:00.000Z"));
  const IN_TWO_HOURS = new Date(Date.parse("2026-08-13T04:00:00.000Z"));

  it("delays every channel by the batch time and stores it on each job", async () => {
    const { createPostBatch, repo, queue } = harness();

    const result = await createPostBatch({ ...BASE_INPUT, scheduledAt: IN_ONE_HOUR });

    expect(queue.enqueued.map((entry) => entry.opts?.delayMs)).toEqual([
      3_600_000 - HANDOFF_WINDOW_START_MS,
      3_600_000 - HANDOFF_WINDOW_START_MS,
    ]);
    for (const job of repo.store.values()) {
      expect(job.scheduledAt).toEqual(IN_ONE_HOUR);
    }
    expect(result.channels.map((entry) => entry.scheduledAt)).toEqual([IN_ONE_HOUR, IN_ONE_HOUR]);
  });

  it("gives each channel its OWN hour (brief §9: khung giờ vàng khác nhau)", async () => {
    const { createPostBatch, repo, queue } = harness();

    const result = await createPostBatch({
      ...BASE_INPUT,
      scheduledAtByChannel: { "fbpage-a": IN_ONE_HOUR, "fbpage-b": IN_TWO_HOURS },
    });

    expect(queue.enqueued.map((entry) => entry.opts?.delayMs)).toEqual([
      3_600_000 - HANDOFF_WINDOW_START_MS,
      7_200_000 - HANDOFF_WINDOW_START_MS,
    ]);
    const jobs = [...repo.store.values()];
    expect(jobs.map((job) => job.scheduledAt)).toEqual([IN_ONE_HOUR, IN_TWO_HOURS]);
    expect(result.channels.map((entry) => entry.scheduledAt)).toEqual([IN_ONE_HOUR, IN_TWO_HOURS]);
  });

  it("lets a per-channel time win over the batch time, and keeps the batch time elsewhere", async () => {
    const { createPostBatch, queue } = harness();
    await createPostBatch({
      ...BASE_INPUT,
      scheduledAt: IN_ONE_HOUR,
      scheduledAtByChannel: { "fbpage-b": IN_TWO_HOURS },
    });
    expect(queue.enqueued.map((entry) => entry.opts?.delayMs)).toEqual([
      3_600_000 - HANDOFF_WINDOW_START_MS,
      7_200_000 - HANDOFF_WINDOW_START_MS,
    ]);
  });

  it("blocks ONLY the channel with a bad hour (rule 6)", async () => {
    const { createPostBatch, repo, queue } = harness();

    const result = await createPostBatch({
      ...BASE_INPUT,
      scheduledAtByChannel: {
        "fbpage-a": IN_ONE_HOUR,
        // Yesterday: a typo or a stale form must never mean "post now".
        "fbpage-b": new Date(Date.parse("2026-08-12T03:00:00.000Z")),
      },
    });

    expect(queue.enqueued).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({ channelId: "fbpage-a", queued: true });
    expect(result.channels[1]).toMatchObject({
      channelId: "fbpage-b",
      queued: false,
      status: "blocked",
      errorCode: "INVALID_INPUT",
      scheduledAt: null,
    });
    expect(result.channels[1].userMessage).toContain("đã trôi qua");
    expect([...repo.store.values()].map((job) => job.status)).toEqual(["queued", "blocked"]);
  });

  it("refuses a per-channel entry for a channel that is not in the batch", async () => {
    const { createPostBatch, queue } = harness();
    await expect(
      createPostBatch({
        ...BASE_INPUT,
        scheduledAtByChannel: { "fbpage-zzz": IN_ONE_HOUR },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { unknown_channels: ["fbpage-zzz"] },
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("queues immediately (no delay, no scheduled_at) when no time is given", async () => {
    const { createPostBatch, repo, queue } = harness();
    await createPostBatch(BASE_INPUT);
    expect(queue.enqueued.every((entry) => entry.opts?.delayMs === undefined)).toBe(true);
    expect([...repo.store.values()].every((job) => job.scheduledAt === null)).toBe(true);
  });

  it("stores the queue id on the job so it can be cancelled later (E8.4)", async () => {
    const { createPostBatch, repo, queue } = harness();
    await createPostBatch({ ...BASE_INPUT, scheduledAt: IN_ONE_HOUR });
    const jobs = [...repo.store.values()];
    expect(jobs.every((job) => typeof job.queueJobId === "string" && job.queueJobId.length > 0)).toBe(
      true,
    );
    expect(jobs.map((job) => job.queueJobId)).toEqual(
      queue.enqueued.map((entry) => entry.opts?.jobId),
    );
  });
});

describe("createPostBatch — video formats (Phase 2)", () => {
  const VIDEO = [{ driveFileId: "clip-1", fileName: "MGKVX6310-Tím (1).mp4", kind: "video" }];

  it.each(["video_post", "reels"] as const)("creates a %s job with one clip", async (format) => {
    const { createPostBatch, repo, queue } = harness();

    const result = await createPostBatch({
      ...BASE_INPUT,
      channelIds: ["fbpage-a"],
      captionByChannel: { "fbpage-a": "Giannal – REEL" },
      format,
      media: VIDEO,
    });

    expect(result.format).toBe(format);
    expect(queue.enqueued).toHaveLength(1);
    const job = [...repo.store.values()][0];
    expect(job.format).toBe(format);
    expect(job.media).toHaveLength(1);
    expect(job.media[0].driveFileId).toBe("clip-1");
  });

  it("refuses more than one clip: three clips mean three posts, not a dropped two", async () => {
    const { createPostBatch, repo } = harness();
    await expect(
      createPostBatch({
        ...BASE_INPUT,
        format: "reels",
        media: [...VIDEO, { driveFileId: "clip-2", kind: "video" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { media_count: 2, format: "reels" } });
    expect(repo.store.size).toBe(0);
  });

  it("refuses an image in a video post and a video in an image post", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({ ...BASE_INPUT, format: "reels", media: [{ driveFileId: "p1", kind: "image" }] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { kind: "image", expected_kind: "video" },
    });
    await expect(
      createPostBatch({ ...BASE_INPUT, media: [{ driveFileId: "c1", kind: "video" }] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { kind: "video", expected_kind: "image" },
    });
  });

  it("still refuses an unknown format", async () => {
    const { createPostBatch } = harness();
    await expect(
      createPostBatch({ ...BASE_INPUT, format: "story" as unknown as "image_post" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

/**
 * Onboarding phase 3: the product text may have been typed on the compose
 * screen. Where it came from is stamped on every job HERE, from the product the
 * batch was actually built on — a later sync deleting or replacing that row must
 * not be able to rewrite the answer to "bài này lấy dữ liệu từ đâu".
 */
describe("createPostBatch — product origin stamp", () => {
  it("stamps sheet for a synced product, on every channel of the batch", async () => {
    const { createPostBatch, repo } = harness();

    await createPostBatch(BASE_INPUT);

    const jobs = [...repo.store.values()];
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.productOrigin)).toEqual(["sheet", "sheet"]);
  });

  it("stamps manual when the batch is built on a typed product", async () => {
    const typed: Product = { ...makeProduct(), origin: "manual" };
    const { createPostBatch, repo, lines } = harness({ product: typed });

    await createPostBatch(BASE_INPUT);

    expect([...repo.store.values()].map((job) => job.productOrigin)).toEqual([
      "manual",
      "manual",
    ]);
    const created = lines.find((entry) => entry.message === "Post batch created");
    expect(created?.context).toMatchObject({ product_origin: "manual" });
  });

  it("never invents an origin: the value handed to the repo is always explicit", async () => {
    const captured: NewPostJob[] = [];
    const repo = makeRepo();
    const create = repo.createBatchWithJobs.bind(repo);
    repo.createBatchWithJobs = async (input: Parameters<PostJobRepo["createBatchWithJobs"]>[0]) => {
      captured.push(...input.jobs);
      return create(input);
    };
    const { createPostBatch } = harness({
      repo,
      product: { ...makeProduct(), origin: "manual" },
    });

    await createPostBatch(BASE_INPUT);

    expect(captured).toHaveLength(2);
    for (const job of captured) expect(job.productOrigin).toBe("manual");
  });
});

/**
 * Onboarding phase 3 — the FIRST of the two stock checks, on a product an
 * operator typed on the compose screen. This half is what the publish-time half
 * (publish-post.test.ts, "stock recheck on a MANUAL product") assumes: a typed
 * row in stock gets queued exactly like a synced one, so a post blocked later
 * really is the SECOND check earning its keep, not the first one having been
 * skipped for typed data.
 */
describe("createPostBatch — stock gate on a MANUAL product (phase 3)", () => {
  const manual = (stockRaw: string, noteRaw = ""): Product => ({
    ...makeProduct(stockRaw, noteRaw),
    origin: "manual",
  });

  it("queues a typed product that is in stock, exactly like a synced one", async () => {
    const { createPostBatch, repo, queue } = harness({ product: manual("104") });

    const result = await createPostBatch(BASE_INPUT);

    expect(result.batchStatus).not.toBe("blocked");
    expect(queue.enqueued).toHaveLength(2);
    for (const job of repo.store.values()) {
      expect(job.status).toBe("queued");
      expect(job.productOrigin).toBe("manual");
    }
  });

  it.each([
    ["a typed zero", "0", ""],
    ["an empty stock field", "", ""],
    ["the sold-out note", "50", "HẾT HÀNG"],
  ])("blocks %s before anything is queued", async (_case, stockRaw, noteRaw) => {
    const { createPostBatch, repo, queue } = harness({ product: manual(stockRaw, noteRaw) });

    const result = await createPostBatch(BASE_INPUT);

    expect(queue.enqueued).toHaveLength(0);
    expect(result.batchStatus).toBe("blocked");
    for (const job of repo.store.values()) {
      expect(job.status).toBe("blocked");
      expect(job.lastErrorCode).toBe("OUT_OF_STOCK");
    }
  });
});
