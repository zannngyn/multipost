import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MYSP_FIELD_MAP,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import { deriveBatchStatus, type PostJob, type PostJobStatus } from "@/core/domain/post-job";
import type { MediaAsset, Product } from "@/core/domain/product";
import type { VideoSpec } from "@/core/domain/video-spec";
import type { CatalogConfigRepo, MediaAssetLookup } from "@/core/ports/drive-source";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { JobProgressStore } from "@/core/ports/job-progress";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type {
  ApplyTransitionInput,
  PostBatchSummary,
  PostJobEventInput,
  PostJobRepo,
} from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type { Tenant } from "@/core/domain/tenant";
import type { TenantRepo } from "@/core/ports/tenant-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPublisher,
  PublishImagePostInput,
  PublishSettings,
  SchedulePostInput,
  SchedulePostResult,
  SignMediaUrlFn,
} from "@/core/ports/publisher";

import type { ReadMediaBytes } from "@/core/usecases/read-media-bytes";

import { channelWriteStubs } from "../__fixtures__/channel-config-repo";
import {
  makeMemoryJobProgressStore,
  makeThrowingJobProgressStore,
} from "../__fixtures__/job-progress-store";
import { makePublishPost, spacingWaitMs } from "../publish-post";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * Every branch of E7.4 with in-memory ports. The publisher is a spy: "was
 * Facebook called?" is the assertion that matters for the stock gate and for the
 * anti-duplicate rules.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

/** Same shape as silentLogger, but every line is kept for assertions. */
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

function fixedClock(startMs = Date.parse("2026-08-13T02:00:00.000Z")): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    nowMs: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function makeJob(overrides: Partial<PostJob> = {}): PostJob {
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
    scheduledAt: null,
    queueJobId: null,
    ...overrides,
  };
}

/** In-memory repo with the SAME optimistic guard as the Drizzle one. */
function makeMemoryRepo(jobs: PostJob[]) {
  const store = new Map(jobs.map((job) => [job.id, job]));
  const transitions: Array<{ from: PostJobStatus; to: PostJobStatus; reason: string; ok: boolean }> = [];
  const transitionInputs: ApplyTransitionInput[] = [];
  const events: PostJobEventInput[] = [];
  const repo: PostJobRepo & {
    transitions: typeof transitions;
    transitionInputs: ApplyTransitionInput[];
    events: PostJobEventInput[];
    get(id: string): PostJob | undefined;
    refreshCalls: string[];
    /** post_batch.spacing_ms of the run under test. Null = no per-run value. */
    batchSpacingMs: number | null;
    batchSpacingCalls: string[];
  } = {
    transitions,
    transitionInputs,
    events,
    refreshCalls: [],
    batchSpacingMs: null,
    batchSpacingCalls: [],
    get: (id: string) => store.get(id),
    async createBatchWithJobs() {
      throw new Error("not used in this test");
    },
    async findJobById(_tenantId: string, postJobId: string) {
      return store.get(postJobId) ?? null;
    },
    async listJobsByBatch(_tenantId: string, batchId: string) {
      return [...store.values()].filter((job) => job.batchId === batchId);
    },
    async listJobs() {
      // Not exercised here: the job log has its own test (list-post-jobs).
      return { items: [], nextCursor: null };
    },
    async applyTransition(input: ApplyTransitionInput) {
      transitionInputs.push(input);
      const current = store.get(input.postJobId);
      const ok = Boolean(current && current.status === input.from);
      transitions.push({ from: input.from, to: input.next.status, reason: input.reason, ok });
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
      return input.next;
    },
    async setQueueJobId(input: { postJobId: string; queueJobId: string | null }) {
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
    async findBatchSpacingMs(_tenantId: string, batchId: string) {
      repo.batchSpacingCalls.push(batchId);
      return repo.batchSpacingMs;
    },
    async findLastPublishedAt(_tenantId: string, channelId: string) {
      const published = [...store.values()]
        .filter((job) => job.channelId === channelId && job.publishedAt)
        .map((job) => job.publishedAt as Date)
        .sort((a, b) => b.getTime() - a.getTime());
      return published[0] ?? null;
    },
    async refreshBatchStatus(_tenantId: string, batchId: string): Promise<PostBatchSummary> {
      repo.refreshCalls.push(batchId);
      const list = [...store.values()].filter((job) => job.batchId === batchId);
      return {
        batchId,
        tenantId: TENANT,
        productCode: list[0]?.productCode ?? "",
        status: deriveBatchStatus(list.map((job) => job.status)),
        total: list.length,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 0,
          published: 0,
          failed: 0,
          blocked: 0,
        },
        startedAt: new Date("2026-08-13T02:00:00.000Z"),
        finishedAt: null,
        jobs: list,
      };
    },
    async getBatchSummary() {
      return null;
    },
    // E7.5 — durable milestones; recorded so a test can prove ONE row per
    // stage change (never one per photo).
    async appendJobEvent(input) {
      repo.events.push(input);
    },
  };
  return repo;
}

function makeProduct(stockRaw: string, noteRaw = ""): Product {
  return {
    content: { code: "MGKVX6310", name: "Giannal", description: null, category: null, season: null },
    operational: { stockRaw, noteRaw, colorsRaw: "TÍM" },
    hasConflict: false,
    sourceRows: [2],
  };
}

/**
 * Doc 10 §5.2 — the suspended-tenant gate needs a tenant row. Default active,
 * so every pre-existing test keeps its behaviour; `status: "suspended"` and
 * `null` are what the two new cases pass in.
 */
function makeTenants(tenant: Tenant | null = ACTIVE_TENANT): TenantRepo {
  return { findById: async () => tenant };
}

const ACTIVE_TENANT: Tenant = { id: TENANT, name: "Demo", status: "active" };

function makeProducts(product: Product | null): ProductRepo {
  return {
    findByCode: async () => product,
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => (product ? 1 : 0),
  };
}

const CHANNEL: ChannelConfig = {
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: "secret",
  status: "active",
  tokenExpiresAt: null,
};

function makeChannels(
  channel: ChannelConfig | null,
  settings: Partial<PublishSettings> = {},
): ChannelConfigRepo {
  return {
    findChannel: async () => channel,
    listChannels: async () => (channel ? [channel] : []),
    getPublishSettings: async () => ({
      spacingMs: 0,
      retryBackoffMs: 1_000,
      maxAttempts: 3,
      ...settings,
    }),
    ...channelWriteStubs(),
  };
}

function makeQueue() {
  const enqueued: Array<{ name: string; payload: unknown; opts?: EnqueueOptions }> = [];
  const queue: JobQueue & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(jobName, payload, opts) {
      enqueued.push({ name: jobName, payload, opts });
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

interface Harness {
  publish: ReturnType<typeof makePublishPost>;
  repo: ReturnType<typeof makeMemoryRepo>;
  queue: ReturnType<typeof makeQueue>;
  /** E7.5 — every stage this run reported, in order. */
  progress: ReturnType<typeof makeMemoryJobProgressStore>;
  publisher: {
    publishImagePost: ReturnType<typeof vi.fn>;
    publishVideoPost: ReturnType<typeof vi.fn>;
    /** E8.6 — absent when the harness builds a platform without a scheduler. */
    scheduled?: {
      schedulePost: ReturnType<typeof vi.fn>;
      getPostState: ReturnType<typeof vi.fn>;
      deleteScheduledPost: ReturnType<typeof vi.fn>;
    };
  };
  clock: ReturnType<typeof fixedClock>;
  signer: ReturnType<typeof fakeSigner>;
  /** The byte source handed to the publisher's lazy `readBytes`. */
  readMediaBytes: ReturnType<typeof vi.fn>;
}

/** Stand-in photo bytes; a real JPEG header so nothing looks like an empty buffer. */
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const MEDIA_BASE_URL = "https://mysp.example.com";

/**
 * Stand-in for the HMAC signer. The expiry is derived from the CLOCK, so a test
 * can prove that a later attempt gets a LATER expiry — i.e. a fresh link.
 */
function fakeSigner(clock: Clock) {
  const calls: Array<{ assetId: string; baseUrl: string; expiresAtMs: number }> = [];
  const sign: SignMediaUrlFn = (input) => {
    const expiresAtMs = clock.nowMs() + (input.ttlMs ?? 6 * 60 * 60 * 1000);
    calls.push({ assetId: input.assetId, baseUrl: input.baseUrl, expiresAtMs });
    const path = `/api/media/${input.assetId}?tenant=${input.tenantId}&expires=${expiresAtMs}&sig=deadbeef`;
    return { url: `${input.baseUrl}${path}`, path, expiresAtMs, signature: "deadbeef" };
  };
  return { sign, calls };
}

function harness(options: {
  jobs?: PostJob[];
  product?: Product | null;
  channel?: ChannelConfig | null;
  settings?: Partial<PublishSettings>;
  publish?: (input: PublishImagePostInput) => Promise<{ postId: string; url: string | null }>;
  publishVideo?: () => Promise<{ postId: string; url: string | null }>;
  publishers?: Partial<Record<"facebook" | "tiktok", ChannelPublisher>>;
  videoProbe?: VideoAssetProbe;
  mediaAssets?: MediaAssetLookup;
  signMediaUrl?: SignMediaUrlFn;
  mediaBaseUrl?: () => string;
  readMediaBytes?: ReadMediaBytes;
  /** E8.6 — what the platform answers when the post is handed over. */
  schedulePost?: (input: SchedulePostInput) => Promise<SchedulePostResult>;
  /** E8.6 — build a publisher that cannot hold a post (TikTok-like). */
  withoutScheduler?: boolean;
  /** E7.5 — swap in a store that breaks, to prove the post still goes out. */
  progress?: JobProgressStore;
  /** Doc 10 §5.2 — `null` = tenant row gone, `suspended` = tenant locked. */
  tenant?: Tenant | null;
  /** Onboarding phase 1 — the tenant's stock policy, or the read that fails. */
  stockPolicy?: StockPolicy | Error;
  /**
   * Full product port, for the cases one fixed answer cannot express: the
   * catalog CHANGING between compose time and publish time is the whole reason
   * business rule 3 checks twice.
   */
  products?: ProductRepo;
  /** Swap the silent logger for a recording one to assert on a log line. */
  lines?: LogLine[];
  /** post_batch.spacing_ms for this run. Undefined/null = no per-run value. */
  batchSpacingMs?: number | null;
} = {}): Harness {
  const repo = makeMemoryRepo(options.jobs ?? [makeJob()]);
  repo.batchSpacingMs = options.batchSpacingMs ?? null;
  const queue = makeQueue();
  const clock = fixedClock();
  const publisher = {
    publishImagePost: vi.fn(
      options.publish ?? (async () => ({ postId: "555000111_1", url: "https://fb/555000111_1" })),
    ),
    // Not derived from `options.publish` any more: an image call now carries
    // byte sources and a video call carries a URL, so one scripted function
    // cannot stand for both.
    publishVideoPost: vi.fn(
      options.publishVideo ?? (async () => ({ postId: "555000111_2", url: "https://fb/555000111_2" })),
    ),
    ...(options.withoutScheduler
      ? {}
      : {
          scheduled: {
            schedulePost: vi.fn(
              options.schedulePost ??
                (async (input: SchedulePostInput) => ({
                  scheduledPostId: "555000111_scheduled",
                  publishAt: input.publishAt,
                })),
            ),
            getPostState: vi.fn(async () => ({ state: "scheduled" as const, postId: "555000111_scheduled", publishAt: null })),
            deleteScheduledPost: vi.fn(async () => true),
          },
        }),
  };
  const signer = fakeSigner(clock);
  // `progress` on the harness is always the RECORDING store; a test that swaps
  // in a broken one is asserting on the job, not on what it recorded.
  const recorded = makeMemoryJobProgressStore();
  const progress = options.progress ?? recorded;
  const readMediaBytes = vi.fn<ReadMediaBytes>(
    options.readMediaBytes ?? (async () => ({ bytes: PHOTO_BYTES, mimeType: "image/jpeg" })),
  );
  return {
    repo,
    queue,
    clock,
    publisher,
    signer,
    readMediaBytes,
    progress: recorded,
    publish: makePublishPost({
      postJobs: repo,
      products:
        options.products ??
        makeProducts(options.product === undefined ? makeProduct("104") : options.product),
      channels: makeChannels(options.channel === undefined ? CHANNEL : options.channel, options.settings),
      tenants: makeTenants(options.tenant === undefined ? ACTIVE_TENANT : options.tenant),
      publisher,
      ...(options.publishers ? { publishers: options.publishers } : {}),
      queue,
      progress,
      clock,
      logger: options.lines ? recordingLogger(options.lines) : silentLogger(),
      ...(options.stockPolicy === undefined
        ? {}
        : { catalogConfig: makeCatalogConfig(options.stockPolicy) }),
      signMediaUrl: options.signMediaUrl ?? signer.sign,
      mediaBaseUrl: options.mediaBaseUrl ?? (() => MEDIA_BASE_URL),
      videoProbe: options.videoProbe,
      mediaAssets: options.mediaAssets,
      readMediaBytes,
    }),
  };
}

// --- Edge cases first -------------------------------------------------------

describe("publishPost — rejected calls", () => {
  it("rejects a malformed tenant id or job id", async () => {
    const { publish } = harness();
    await expect(publish({ tenantId: testTenantId("nope"), postJobId: "job-1" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(publish({ tenantId: TENANT, postJobId: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects an unknown job without calling the platform", async () => {
    const { publish, publisher } = harness();
    await expect(publish({ tenantId: TENANT, postJobId: "ghost" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "POST_JOB_NOT_FOUND" },
    });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });
});

describe("publishPost — suspended tenant (doc 10 §5.2)", () => {
  // The failure this exists for: a tenant is suspended at 09:00 and its 10:00
  // scheduled post still lands on a real Page, because the worker has no
  // session and `requireTenant()` never runs for it.
  it("publishes NOTHING for a suspended tenant and blocks the job with a reason", async () => {
    const h = harness({ tenant: { id: TENANT, name: "Demo", status: "suspended" } });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("TENANT_SUSPENDED");
    expect(result.userMessage).toContain("tạm khoá");
    expect(h.repo.get("job-1")?.status).toBe("blocked");
  });

  it("names the event in the audit row, not just the status", async () => {
    const h = harness({ tenant: { id: TENANT, name: "Demo", status: "suspended" } });
    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const blocked = h.repo.transitionInputs.find((input) => input.next.status === "blocked");
    expect(blocked?.auditAction).toBe("post_job.blocked_tenant_suspended");
  });

  it("blocks a SCHEDULED post before the handoff, so Facebook never holds it", async () => {
    // The dangerous path: a handed-over post publishes at its hour even if this
    // process dies, so the gate must sit BEFORE the handoff window, not after.
    // T+20min: INSIDE the handoff window, i.e. the exact instant at which an
    // active tenant's post is handed to Facebook (see the E8.6 happy path).
    const inHandoffWindow = new Date(Date.parse("2026-08-13T02:00:00.000Z") + 20 * 60_000);
    const h = harness({
      jobs: [makeJob({ scheduledAt: inHandoffWindow })],
      tenant: { id: TENANT, name: "Demo", status: "suspended" },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("refuses a job whose tenant row is gone, with its own reason", async () => {
    const h = harness({ tenant: null });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("TENANT_SUSPENDED");
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("does not stand in the way of an ACTIVE tenant", async () => {
    const h = harness();
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
  });
});

describe("publishPost — anti-duplicate guards (business rule 4)", () => {
  it("re-running a published job publishes NOTHING (crash after publish, before the status write)", async () => {
    const published = makeJob({
      status: "published",
      publishedPostId: "555000111_1",
      publishedAt: new Date(),
      attemptCount: 1,
    });
    const { publish, publisher } = harness({ jobs: [published] });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });

    expect(result.outcome).toBe("already_published");
    expect(result.publishedPostId).toBe("555000111_1");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("never touches a job left in `publishing` by a dead worker", async () => {
    const { publish, publisher } = harness({ jobs: [makeJob({ status: "publishing", attemptCount: 1 })] });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });
    expect(result.outcome).toBe("skipped");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it.each(["draft", "blocked", "failed"] as PostJobStatus[])(
    "skips a job in %s instead of publishing it",
    async (status) => {
      const { publish, publisher } = harness({
        jobs: [makeJob({ status, lastErrorCode: status === "draft" ? null : "OUT_OF_STOCK" })],
      });
      const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
      expect(result.outcome).toBe("skipped");
      expect(publisher.publishImagePost).not.toHaveBeenCalled();
    },
  );

  it("stops quietly when another worker won the claim race", async () => {
    const { publish, publisher, repo } = harness();
    // Simulate the competitor winning between findJobById and the UPDATE.
    const original = repo.applyTransition.bind(repo);
    repo.applyTransition = async (input) => {
      if (input.next.status === "publishing") return null;
      return original(input);
    };

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("skipped");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("two concurrent runs of the same job publish exactly once", async () => {
    const { publish, publisher } = harness();
    const results = await Promise.allSettled([
      publish({ tenantId: TENANT, postJobId: "job-1" }),
      publish({ tenantId: TENANT, postJobId: "job-1" }),
    ]);
    const outcomes = results.map((entry) =>
      entry.status === "fulfilled" ? entry.value.outcome : "threw",
    );
    expect(outcomes.filter((outcome) => outcome === "published")).toHaveLength(1);
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });
});

describe("publishPost — stock recheck (business rule 3)", () => {
  it("blocks a sold-out product BEFORE any call to the channel", async () => {
    const { publish, publisher, repo } = harness({ product: makeProduct("0") });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")).toMatchObject({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" });
    expect(result.userMessage).toContain("hết hàng");
  });

  it("blocks on the note 'HẾT HÀNG' even when the number looks fine", async () => {
    const { publish, publisher } = harness({ product: makeProduct("50", "HẾT HÀNG") });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.errorCode).toBe("OUT_OF_STOCK");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("blocks when the product vanished from the snapshot", async () => {
    const { publish, publisher, repo } = harness({ product: null });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "PRODUCT_NOT_FOUND" });
    expect(repo.get("job-1")?.status).toBe("blocked");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("publishes a low-stock product (1..3) — the warning stays internal", async () => {
    const { publish, publisher } = harness({ product: makeProduct("3") });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
    const caption = publisher.publishImagePost.mock.calls[0][0].caption as string;
    expect(caption).not.toContain("Tồn thấp");
  });
});

/**
 * Onboarding phase 1 — the tenant's StockPolicy reaching the SECOND stock check,
 * the one that runs on the line before the platform call (business rule 3).
 * Edge cases first: the unreadable config and the modes that must keep blocking.
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

describe("publishPost — tenant stock policy (onboarding phase 1)", () => {
  it("fails loudly and publishes NOTHING when the stored policy cannot be read", async () => {
    const lines: LogLine[] = [];
    const { publish, publisher, repo } = harness({
      product: makeProduct("104"),
      stockPolicy: new AppError("SYNC_FAILED", { message: "invalid stockPolicy" }),
      lines,
    });

    await expect(publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "SYNC_FAILED",
    });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    // Read BEFORE the claim: a broken config must never strand a row in
    // `publishing`, which nothing auto-recovers.
    expect(repo.get("job-1")?.status).toBe("queued");
    expect(
      lines.some(
        (line) => line.level === "error" && line.context?.reason === "STOCK_POLICY_UNREADABLE",
      ),
    ).toBe(true);
  });

  it("keeps the numeric behaviour when no config repo is wired", async () => {
    const { publish, publisher } = harness({ product: makeProduct("0") });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("numeric mode is unchanged when the repo answers the default", async () => {
    const { publish, publisher } = harness({
      product: makeProduct("0"),
      stockPolicy: { mode: "numeric" },
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("textual: publishes a declared in-stock wording that numeric mode would block", async () => {
    const { publish, publisher } = harness({
      product: makeProduct("Còn hàng"),
      stockPolicy: TEXTUAL_POLICY,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("textual: blocks a declared out-of-stock wording right before the API call", async () => {
    const { publish, publisher, repo } = harness({
      product: makeProduct("Hết hàng"),
      stockPolicy: TEXTUAL_POLICY,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")?.status).toBe("blocked");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("textual: blocks a wording the tenant never declared — no guessing", async () => {
    const lines: LogLine[] = [];
    const { publish, publisher } = harness({
      product: makeProduct("sắp về"),
      stockPolicy: TEXTUAL_POLICY,
      lines,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(
      lines.some(
        (line) =>
          line.context?.reason === "STOCK_TEXT_UNKNOWN" &&
          line.context?.stock_policy_mode === "textual",
      ),
    ).toBe(true);
  });

  it("disabled: publishes an empty stock cell and says NOBODY checked", async () => {
    const lines: LogLine[] = [];
    const { publish, publisher } = harness({
      product: makeProduct(""),
      stockPolicy: DISABLED_POLICY,
      lines,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    // This is the line that answers "vì sao bài này lên dù hết hàng".
    const skipped = lines.find((line) => line.context?.stock_check_skipped === true);
    expect(skipped).toBeDefined();
    expect(skipped?.level).toBe("warn");
    expect(skipped?.context).toMatchObject({
      stock_policy_mode: "disabled",
      stock_check_skipped_reason: "Khách quản lý tồn kho trên phần mềm riêng",
    });
    // ...and the published line carries it too, so the success record is honest.
    const published = lines.find((line) => line.context?.outcome === "published");
    expect(published?.context).toMatchObject({
      stock_policy_mode: "disabled",
      stock_check_skipped: true,
    });
  });

  it("disabled: 'HẾT HÀNG' in the note still blocks", async () => {
    const { publish, publisher, repo } = harness({
      product: makeProduct("50", "HẾT HÀNG"),
      stockPolicy: DISABLED_POLICY,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")?.status).toBe("blocked");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("disabled: conflicting sheet rows still block", async () => {
    const conflicting: Product = { ...makeProduct("104"), hasConflict: true };
    const { publish, publisher } = harness({
      product: conflicting,
      stockPolicy: DISABLED_POLICY,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("a policy that itself is invalid blocks instead of publishing unchecked", async () => {
    // Hand-edited row shape: `disabled` without the required written reason.
    const { publish, publisher } = harness({
      product: makeProduct("104"),
      stockPolicy: { mode: "disabled", reason: "" } as StockPolicy,
    });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });
});

describe("publishPost — channel configuration", () => {
  it("blocks when the tenant has no such channel", async () => {
    const { publish, publisher, repo } = harness({ channel: null });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "CHANNEL_NOT_CONFIGURED" });
    expect(repo.get("job-1")?.status).toBe("blocked");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("blocks when the channel is disabled", async () => {
    const { publish, publisher } = harness({ channel: { ...CHANNEL, status: "disabled" } });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.errorCode).toBe("CHANNEL_NOT_CONFIGURED");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });
});

describe("publishPost — spacing gate (brief §6, PENDING(E1): per channel)", () => {
  it("re-enqueues with the remaining delay instead of publishing too soon", async () => {
    const previous = makeJob({
      id: "job-0",
      status: "published",
      publishedPostId: "555000111_0",
      publishedAt: new Date("2026-08-13T01:59:30.000Z"),
    });
    const { publish, publisher, queue, repo } = harness({
      jobs: [previous, makeJob()],
      settings: { spacingMs: 60_000 },
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(30_000);
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    // Still queued: a deferred post must not sit in `publishing`.
    expect(repo.get("job-1")?.status).toBe("queued");
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].opts?.delayMs).toBe(30_000);
    // A NEW queue id, otherwise BullMQ would drop the re-enqueue.
    expect(queue.enqueued[0].opts?.jobId).toMatch(/\.d\d+$/);
  });

  it("publishes immediately once the gap has elapsed", async () => {
    const previous = makeJob({
      id: "job-0",
      status: "published",
      publishedPostId: "555000111_0",
      publishedAt: new Date("2026-08-13T01:58:00.000Z"),
    });
    const { publish, publisher, queue } = harness({
      jobs: [previous, makeJob()],
      settings: { spacingMs: 60_000 },
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("does not delay the first post of a channel", async () => {
    const { publish, publisher } = harness({ settings: { spacingMs: 120_000 } });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });
});

/**
 * Per-RUN spacing: post_batch.spacing_ms decides the gap for this lô, and the
 * tenant setting is the fallback. Only the SOURCE of the number changes — the
 * gate itself (per channel PENDING(E1), SPACING_GATE deferral, real deadline)
 * is the same one tested above.
 */
describe("publishPost — spacing gate reads the run's own gap first", () => {
  /** A post that went out 30s before the fixed clock, on the same channel. */
  function previousPost() {
    return makeJob({
      id: "job-0",
      status: "published",
      publishedPostId: "555000111_0",
      publishedAt: new Date("2026-08-13T01:59:30.000Z"),
    });
  }

  it("keeps the OLD behaviour when the run has no gap of its own (null column)", async () => {
    const { publish, repo, queue } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: null,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(30_000);
    expect(queue.enqueued[0].opts?.delayMs).toBe(30_000);
    expect(repo.get("job-1")?.status).toBe("queued");
    // The gate did ask the batch — it just got no answer.
    expect(repo.batchSpacingCalls).toEqual(["batch-1"]);
  });

  it("treats a run gap of 0 as a VALUE and publishes even though the tenant says 60s", async () => {
    const { publish, publisher, queue } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 0,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("lets a LONGER run gap win over the tenant setting", async () => {
    const { publish, publisher, queue, repo } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 300_000,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    // 5 minutes asked, 30 seconds already elapsed.
    expect(result.deferredMs).toBe(270_000);
    expect(queue.enqueued[0].opts?.delayMs).toBe(270_000);
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(repo.get("job-1")?.status).toBe("queued");
  });

  it("lets a SHORTER run gap win over the tenant setting", async () => {
    const { publish, publisher } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 600_000 },
      batchSpacingMs: 20_000,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    // 20s asked, 30s already elapsed: nothing left to wait for.
    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("names the SOURCE of the gap in the deferral log and the progress detail", async () => {
    const lines: LogLine[] = [];
    const { publish, progress, repo } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 300_000,
      lines,
    });

    await publish({ tenantId: TENANT, postJobId: "job-1" });

    const deferred = lines.find((line) => line.context?.defer_reason === "SPACING_GATE");
    expect(deferred?.context).toMatchObject({
      spacing_ms: 300_000,
      spacing_source: "batch",
      tenant_spacing_ms: 60_000,
    });
    expect(progress.stages()).toContain("waiting_for_spacing");
    // E7.5 milestone carries the same two numbers, so the tracking screen can
    // explain the wait without a second query.
    const event = repo.events.find((entry) => entry.stage === "waiting_for_spacing");
    expect(event?.detail).toMatchObject({
      wait_ms: 270_000,
      spacing_ms: 300_000,
      spacing_source: "batch",
    });
  });

  it("does not make two channels wait for each other — PENDING(E1) is unchanged", async () => {
    const otherChannel = makeJob({
      id: "job-0",
      channelId: "chan-other",
      status: "published",
      publishedPostId: "555000111_0",
      publishedAt: new Date("2026-08-13T01:59:59.000Z"),
    });
    const { publish, publisher } = harness({
      jobs: [otherChannel, makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 600_000,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("caps a clock skew against the RUN gap, not against the tenant one", async () => {
    const future = makeJob({
      id: "job-0",
      status: "published",
      publishedPostId: "555000111_0",
      // Published "an hour from now": a wrong clock somewhere.
      publishedAt: new Date("2026-08-13T03:00:00.000Z"),
    });
    const { publish, queue } = harness({
      jobs: [future, makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 120_000,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(120_000);
    expect(queue.enqueued[0].opts?.delayMs).toBe(120_000);
  });

  it("IGNORES an impossible stored gap, says so loudly, and falls back to the tenant", async () => {
    const lines: LogLine[] = [];
    const { publish, queue } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: -5,
      lines,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(30_000);
    expect(queue.enqueued[0].opts?.delayMs).toBe(30_000);
    const warn = lines.find((line) => line.context?.reason === "BATCH_SPACING_OUT_OF_RANGE");
    expect(warn?.level).toBe("warn");
    expect(warn?.context).toMatchObject({ batch_spacing_ms: -5, tenant_spacing_ms: 60_000 });
  });

  it("ignores a stored gap above the 24h ceiling the same way", async () => {
    const lines: LogLine[] = [];
    const { publish } = harness({
      jobs: [previousPost(), makeJob()],
      settings: { spacingMs: 60_000 },
      batchSpacingMs: 24 * 60 * 60_000 + 1,
      lines,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.deferredMs).toBe(30_000);
    expect(lines.some((line) => line.context?.reason === "BATCH_SPACING_OUT_OF_RANGE")).toBe(true);
  });

  it("stops the attempt when the run gap cannot be READ — nothing claimed, nothing sent", async () => {
    const lines: LogLine[] = [];
    const { publish, publisher, repo } = harness({
      jobs: [makeJob()],
      settings: { spacingMs: 60_000 },
      lines,
    });
    repo.findBatchSpacingMs = async () => {
      throw new AppError("DB_ERROR", { message: "connection reset" });
    };

    await expect(publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "DB_ERROR",
    });
    // Still `queued`: the queue can retry it, and no row is stranded.
    expect(repo.get("job-1")?.status).toBe("queued");
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(
      lines.some((line) => line.context?.reason === "BATCH_SPACING_UNREADABLE"),
    ).toBe(true);
  });
});

describe("spacingWaitMs", () => {
  const now = Date.parse("2026-08-13T02:00:00.000Z");
  it("returns 0 without a previous post, with spacing 0, or once elapsed", () => {
    expect(spacingWaitMs(null, now, 60_000)).toBe(0);
    expect(spacingWaitMs(new Date(now - 1_000), now, 0)).toBe(0);
    expect(spacingWaitMs(new Date(now - 60_000), now, 60_000)).toBe(0);
  });
  it("returns the remaining gap", () => {
    expect(spacingWaitMs(new Date(now - 20_000), now, 60_000)).toBe(40_000);
  });
  it("caps a clock skew (last post in the future) instead of waiting forever", () => {
    expect(spacingWaitMs(new Date(now + 3_600_000), now, 60_000)).toBe(60_000);
  });
});

/**
 * These fakes stand in for a ChannelPublisher, so they obey ITS contract: every
 * error names whether a request capable of creating the post was dispatched
 * (core/ports/publisher.ts). `platform_created_nothing: true` here is not
 * decoration — it is what a real publisher puts on a pre-flight refusal, a byte
 * read and an unpublished-photo upload, and it is what keeps the retry alive.
 * The flagless case has its own describe block below.
 */
describe("publishPost — platform failures", () => {
  it("blocks (no retry) when the token is dead", async () => {
    const tokenError = new AppError("TOKEN_EXPIRED", {
      message: "Session expired",
      // Found BEFORE the creating request — e.g. Graph refusing the first
      // unpublished photo upload. That is what makes `blocked` (a status an
      // operator may re-queue from) the right answer.
      context: { graph_code: 190, retryable: false, platform_created_nothing: true },
    });
    const { publish, publisher, repo } = harness({
      publish: async () => {
        throw tokenError;
      },
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "TOKEN_EXPIRED" });
    expect(repo.get("job-1")).toMatchObject({ status: "blocked", lastErrorCode: "TOKEN_EXPIRED" });
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("puts the job back in `queued` and rethrows when a retry is left", async () => {
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("META_ERROR", {
          context: { retryable: true, platform_created_nothing: true },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "META_ERROR" });

    expect(repo.get("job-1")).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lastErrorCode: "META_ERROR",
    });
  });

  it("fails permanently on the last attempt", async () => {
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("META_ERROR", {
          context: { retryable: true, platform_created_nothing: true },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 3, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED" });

    expect(repo.get("job-1")).toMatchObject({ status: "failed", lastErrorCode: "PUBLISH_FAILED" });
  });

  it("does not burn retries on a non-retryable platform error", async () => {
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("META_ERROR", {
          context: {
            retryable: false,
            reason: "PERMISSION_DENIED",
            // A permission check that failed before the album was even uploaded.
            platform_created_nothing: true,
          },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED" });

    expect(repo.get("job-1")?.status).toBe("failed");
    // An ordinary failure: the operator may re-run it, nothing is on the Page.
    expect(repo.get("job-1")?.lastErrorCode).toBe("PUBLISH_FAILED");
  });
});

/**
 * B2 — the door BullMQ opened by itself. The three doors closed before this one
 * all needed an operator to press something; this one is the queue's own
 * backoff, and the request it repeats is the one that creates the post.
 *
 * The rule under test: a retry needs PROOF that nothing was created. No proof —
 * the creating request was dispatched, or the publisher said nothing at all —
 * means the job stops, whatever `retryable` claims.
 */
describe("publishPost — no automatic second attempt at a creating request", () => {
  /** What a real publisher throws when the answer to /feed never arrived. */
  const dispatched = () =>
    new AppError("META_ERROR", {
      message: "socket hang up",
      userMessage: "Không kết nối được tới Facebook — hệ thống sẽ thử lại.",
      // The error map calls a timeout retryable, and it IS: the CALL could
      // succeed later. That says nothing about whether repeating it is safe.
      context: { retryable: true, reason: "NETWORK_ERROR", feed_dispatched: true },
    });

  it("fails the job instead of re-queueing when the creating request was dispatched", async () => {
    const { publish, publisher, repo, queue } = harness({
      publish: async () => {
        throw dispatched();
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      // PUBLISH_FAILED is in the queue adapter's NON_RETRYABLE_CODES, so BullMQ
      // raises an UnrecoverableError instead of backing off into a second /feed.
      code: "PUBLISH_FAILED",
      context: { publish_evidence: "feed_dispatched", retryable: false },
    });

    const row = repo.get("job-1");
    expect(row?.status).toBe("failed");
    expect(row?.lastErrorCode).toBe("PUBLISH_UNCONFIRMED");
    expect(row?.lastErrorMessage).toContain("CÓ THỂ đã lên kênh");
    expect(row?.lastErrorMessage).toContain("mở Trang kiểm tra");
    // Two attempts were still allowed; neither the usecase nor the queue takes
    // them, and the publisher was called exactly once.
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("does not block on TOKEN_EXPIRED answered TO the creating request", async () => {
    // `blocked` is a status an operator may re-queue from, and a 190 coming back
    // from a dispatched /feed says the token died — not that the Page is empty.
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("TOKEN_EXPIRED", {
          message: "Session expired",
          context: { graph_code: 190, retryable: false, feed_dispatched: true },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED" });

    expect(repo.get("job-1")).toMatchObject({
      status: "failed",
      lastErrorCode: "PUBLISH_UNCONFIRMED",
    });
  });

  it("fails closed for a publisher that forgot the flag entirely", async () => {
    // A publisher out of contract must not silently regain the retry: "no
    // evidence" is treated exactly like "a post may exist", and the log says so.
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("META_ERROR", { context: { retryable: true } });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ context: { publish_evidence: "none" } });

    expect(repo.get("job-1")).toMatchObject({
      status: "failed",
      lastErrorCode: "PUBLISH_UNCONFIRMED",
    });
  });

  it("treats a publisher that sets BOTH flags as a dispatch", async () => {
    const { publish, repo } = harness({
      publish: async () => {
        throw new AppError("META_ERROR", {
          context: { retryable: true, platform_created_nothing: true, feed_dispatched: true },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ context: { publish_evidence: "contradictory" } });

    expect(repo.get("job-1")?.lastErrorCode).toBe("PUBLISH_UNCONFIRMED");
  });

  it("keeps the retry for everything BEFORE the creating request", async () => {
    // The other half of the trade: the upload phase is most of the error surface
    // and is provably safe to repeat, so it must behave exactly as it did.
    let attempts = 0;
    const { publish, repo } = harness({
      publish: async () => {
        attempts += 1;
        throw new AppError("META_ERROR", {
          message: "Graph refused photo 3",
          context: { retryable: true, reason: "RATE_LIMITED", platform_created_nothing: true },
        });
      },
    });

    await expect(
      publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "META_ERROR" });

    expect(attempts).toBe(1);
    expect(repo.get("job-1")).toMatchObject({ status: "queued", lastErrorCode: "META_ERROR" });
  });
});

describe("publishPost — photos travel as BYTES (E5, the Graph 324 fix)", () => {
  it("hands the publisher a lazy byte source per photo, in album order", async () => {
    const h = harness({
      jobs: [
        makeJob({
          media: [
            { driveFileId: "drive-1", fileName: "1.jpg", url: "https://old.example/stale-1.jpg" },
            { driveFileId: "drive-2", fileName: "2.jpg", url: "https://old.example/stale-2.jpg" },
          ],
        }),
      ],
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const input = h.publisher.publishImagePost.mock.calls[0][0];
    expect(input.media.map((item: { driveFileId: string }) => item.driveFileId)).toEqual([
      "drive-1",
      "drive-2",
    ]);
    // Lazy: nothing is read until the publisher asks for that photo.
    expect(h.readMediaBytes).not.toHaveBeenCalled();
    // No URL is minted for a photo any more — that handover is what failed.
    expect(h.signer.calls).toHaveLength(0);
    expect(input.media[0].url).toBeUndefined();

    const content = await input.media[1].readBytes();
    expect(content).toEqual({ bytes: PHOTO_BYTES, mimeType: "image/jpeg" });
    expect(h.readMediaBytes).toHaveBeenCalledWith({
      tenantId: TENANT,
      assetId: "drive-2",
      jobId: "job-1",
    });
  });

  it("publishes an image post even when MEDIA_PUBLIC_BASE_URL is missing", async () => {
    // The photo path no longer depends on a publicly reachable URL at all —
    // that is half the point of uploading the bytes.
    const h = harness({
      mediaBaseUrl: () => {
        throw new AppError("INVALID_INPUT", { message: "MEDIA_PUBLIC_BASE_URL is missing" });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("blocks a legacy item that has no asset id to read bytes from", async () => {
    const h = harness({
      jobs: [
        makeJob({ media: [{ driveFileId: "", fileName: "old.jpg", url: "https://cdn/old.jpg" }] }),
      ],
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "MEDIA_NOT_FOUND" });
    expect(result.userMessage).toContain("old.jpg");
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.status).toBe("blocked");
  });

  it("re-reads the bytes on a retried attempt instead of reusing a stale handle", async () => {
    let fail = true;
    const h = harness({
      publish: async ({ media }: PublishImagePostInput) => {
        // The real publisher reads inside the call; the fake does the same so
        // the retry is measured the way production behaves.
        for (const item of media) await item.readBytes();
        if (fail) {
          fail = false;
          // An upload-phase failure: nothing that creates a post went out, which
          // is what leaves the second attempt available.
          throw new AppError("META_ERROR", {
            message: "temporary",
            context: { retryable: true, platform_created_nothing: true },
          });
        }
        return { postId: "555000111_2", url: null };
      },
    });

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "META_ERROR" });
    h.clock.advance(7 * 60 * 60 * 1000);
    await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });

    expect(h.readMediaBytes).toHaveBeenCalledTimes(2);
  });

  it("fails the attempt (retryable) when the bytes cannot be read", async () => {
    const h = harness({
      readMediaBytes: async () => {
        throw new AppError("DRIVE_ERROR", { message: "Drive is unreachable" });
      },
      publish: async ({ media }: PublishImagePostInput) => {
        // Mirrors the real adapter's readPart: a byte read sends nothing to the
        // platform, so the error says so and stays retryable.
        try {
          for (const item of media) await item.readBytes();
        } catch (error) {
          throw AppError.from(error, "DRIVE_ERROR", { platform_created_nothing: true });
        }
        return { postId: "555000111_1", url: null };
      },
    });

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "DRIVE_ERROR" });
    // Back to `queued`: a Drive hiccup is worth another attempt, and the post
    // was never created on the platform.
    expect(h.repo.get("job-1")).toMatchObject({ status: "queued", lastErrorCode: "DRIVE_ERROR" });
  });

  it("reads nothing at all when the stock recheck blocks the post", async () => {
    const h = harness({ product: makeProduct("0") });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.errorCode).toBe("OUT_OF_STOCK");
    expect(h.readMediaBytes).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });
});

describe("publishPost — signed media URLs stay on the VIDEO path (E3.6)", () => {
  const videoJob = () =>
    makeJob({
      format: "video_post",
      media: [{ driveFileId: "drive-9", fileName: "clip.mp4", url: "https://old.example/x.mp4" }],
    });

  it("re-signs the video URL immediately before the API call", async () => {
    const h = harness({ jobs: [videoJob()] });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const input = h.publisher.publishVideoPost.mock.calls[0][0];
    expect(h.signer.calls.map((call) => call.assetId)).toEqual(["drive-9"]);
    expect(input.videoUrl).toBe(
      `${MEDIA_BASE_URL}/api/media/drive-9?tenant=${TENANT}&expires=${h.signer.calls[0].expiresAtMs}&sig=deadbeef`,
    );
    // The row keeps the URL it was created with; only the outbound call is fresh.
    expect(h.repo.get("job-1")?.media[0].url).toBe("https://old.example/x.mp4");
  });

  it("blocks a VIDEO job (never calls the platform) when the base URL is missing", async () => {
    const h = harness({
      jobs: [videoJob()],
      mediaBaseUrl: () => {
        throw new AppError("INVALID_INPUT", { message: "MEDIA_PUBLIC_BASE_URL is missing" });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")).toMatchObject({
      status: "blocked",
      lastErrorCode: "INVALID_INPUT",
    });
    expect(result.userMessage).toContain("MEDIA_PUBLIC_BASE_URL");
  });
});

describe("publishPost — happy path", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("publishes, stores the post id and refreshes the batch summary", async () => {
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 });

    expect(result).toMatchObject({
      outcome: "published",
      status: "published",
      publishedPostId: "555000111_1",
      publishedUrl: "https://fb/555000111_1",
      channelId: "fbpage-a",
    });
    expect(h.repo.get("job-1")).toMatchObject({
      status: "published",
      attemptCount: 1,
      publishedPostId: "555000111_1",
      lastErrorCode: null,
    });
    expect(h.repo.refreshCalls).toContain("batch-1");
  });

  it("hands the publisher the caption, the ordered album and the duplicate key", async () => {
    await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    const input = h.publisher.publishImagePost.mock.calls[0][0];
    expect(input.caption).toBe("Giannal – MỘT NGÀY DỊU DÀNG");
    expect(input.media).toHaveLength(1);
    // Same tuple as post_job_duplicate_uq, tenant included (gate note #3).
    expect(input.idempotencyKey).toBe(`${TENANT}|batch-1|MGKVX6310|TÍM|fbpage-a|image_post`);
    expect(input.channel.channelId).toBe("fbpage-a");
  });

  it("follows the mandated order: claim -> stock -> channel -> publish", async () => {
    const order: string[] = [];
    const repo = makeMemoryRepo([makeJob()]);
    const originalTransition = repo.applyTransition.bind(repo);
    repo.applyTransition = async (input) => {
      order.push(`transition:${input.next.status}`);
      return originalTransition(input);
    };
    const products: ProductRepo = {
      findByCode: async () => {
        order.push("stock-recheck");
        return makeProduct("104");
      },
      upsertMany: async () => 0,
      deleteStale: async () => 0,
      countAll: async () => 1,
    };
    const channels: ChannelConfigRepo = {
      findChannel: async () => {
        order.push("channel-config");
        return CHANNEL;
      },
      listChannels: async () => [CHANNEL],
      getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
      ...channelWriteStubs(),
    };
    const publish = makePublishPost({
      postJobs: repo,
      products,
      channels,
      tenants: makeTenants(),
      publisher: {
        publishImagePost: async (input) => {
          order.push("publish");
          // The real adapter reads each photo inside the call; doing the same
          // here is what puts "read-bytes" in its true place in the order.
          for (const item of input.media) await item.readBytes();
          return { postId: "555000111_9", url: null };
        },
        publishVideoPost: async () => {
          order.push("publish-video");
          return { postId: "555000111_9", url: null };
        },
      },
      queue: makeQueue(),
      progress: makeMemoryJobProgressStore(),
      clock: fixedClock(),
      logger: silentLogger(),
      signMediaUrl: fakeSigner(fixedClock()).sign,
      mediaBaseUrl: () => MEDIA_BASE_URL,
      readMediaBytes: async () => {
        order.push("read-bytes");
        return { bytes: PHOTO_BYTES, mimeType: "image/jpeg" };
      },
    });

    await publish({ tenantId: TENANT, postJobId: "job-1" });

    // The bytes are read AFTER the claim and AFTER the stock recheck: business
    // rule 3 stays the last gate, the upload is only preparation for the call.
    expect(order).toEqual([
      "transition:publishing",
      "stock-recheck",
      "channel-config",
      "publish",
      "read-bytes",
      "transition:published",
    ]);
  });
});

describe("publishPost — scheduled posts (E8.2/E8.3/E8.5)", () => {
  const SCHEDULED_AT = new Date("2026-08-13T01:00:00.000Z");

  it("rechecks stock at the scheduled hour and auto-cancels a sold-out post", async () => {
    // The brief's exact scenario: "hẹn hôm nay mai đăng, trong đêm hàng bán hết".
    const h = harness({
      jobs: [makeJob({ scheduledAt: SCHEDULED_AT })],
      product: makeProduct("0"),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("OUT_OF_STOCK");
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    // E8.3: the audit row names the EVENT, not just the status.
    const blocked = h.repo.transitionInputs.find((input) => input.next.status === "blocked");
    expect(blocked?.auditAction).toBe("post_job.auto_cancelled");
  });

  it("keeps the plain block action for an immediate post (no schedule)", async () => {
    const h = harness({ jobs: [makeJob({ scheduledAt: null })], product: makeProduct("0") });
    await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    const blocked = h.repo.transitionInputs.find((input) => input.next.status === "blocked");
    expect(blocked?.auditAction).toBeUndefined();
  });

  it("marks a scheduled post that fails at its hour with its own audit action (E8.5)", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: SCHEDULED_AT })],
      publish: async () => {
        throw new AppError("META_ERROR", {
          message: "permission denied",
          context: { retryable: false },
        });
      },
    });

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED" });

    const failed = h.repo.transitionInputs.find((input) => input.next.status === "failed");
    expect(failed?.auditAction).toBe("post_job.scheduled_publish_failed");
  });

  it("publishes normally when the hour comes and stock is fine", async () => {
    const h = harness({ jobs: [makeJob({ scheduledAt: SCHEDULED_AT })] });
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });
});

describe("publishPost — stale queue entry guard (E8.4)", () => {
  const NEW_ENTRY = "pp.job-1.MGKVX6310.T-M.fbpage-a.d1786574288282";

  it("publishes when the running entry IS the one stored on the job", async () => {
    const h = harness({ jobs: [makeJob({ queueJobId: NEW_ENTRY })] });

    const result = await h.publish({
      tenantId: TENANT,
      postJobId: "job-1",
      queueJobId: NEW_ENTRY,
    });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("skips a STALE entry: the old hour must not publish after a reschedule", async () => {
    const h = harness({
      jobs: [makeJob({ queueJobId: NEW_ENTRY, scheduledAt: new Date("2026-08-13T09:00:00.000Z") })],
    });

    const result = await h.publish({
      tenantId: TENANT,
      postJobId: "job-1",
      queueJobId: "pp.job-1.MGKVX6310.T-M.fbpage-a",
      attempt: 1,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({ outcome: "skipped", skipReason: "STALE_QUEUE_ENTRY" });
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    // Nothing burned: no claim, no attempt, no audit row, status untouched.
    expect(h.repo.transitions).toHaveLength(0);
    expect(h.repo.get("job-1")).toMatchObject({ status: "queued", attemptCount: 0 });
  });

  it("still publishes a row created before the queue id existed (queue_job_id NULL)", async () => {
    const h = harness({ jobs: [makeJob({ queueJobId: null })] });

    const result = await h.publish({
      tenantId: TENANT,
      postJobId: "job-1",
      queueJobId: "pp.whatever",
    });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("does not guard when the caller passes no queue id", async () => {
    const h = harness({ jobs: [makeJob({ queueJobId: NEW_ENTRY })] });
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
  });
});

describe("publishPost — the deferred entry is not stale (E8.4 regression)", () => {
  it("points the row at the deferred entry before re-enqueueing", async () => {
    const h = harness({
      jobs: [
        makeJob({ queueJobId: "pp.first-entry" }),
        makeJob({
          id: "job-0",
          status: "published",
          publishedAt: new Date("2026-08-13T01:59:30.000Z"),
          publishedPostId: "555000111_0",
        }),
      ],
      settings: { spacingMs: 60_000 },
    });

    const deferred = await h.publish({
      tenantId: TENANT,
      postJobId: "job-1",
      queueJobId: "pp.first-entry",
    });

    expect(deferred.outcome).toBe("deferred");
    const newId = h.queue.enqueued[0].opts?.jobId;
    expect(newId).not.toBe("pp.first-entry");
    // Without this the deferred entry would look stale and never publish.
    expect(h.repo.get("job-1")?.queueJobId).toBe(newId);

    // And the deferred entry does publish once the spacing window has passed.
    h.clock.advance(60_000);
    const published = await h.publish({
      tenantId: TENANT,
      postJobId: "job-1",
      queueJobId: newId,
    });
    expect(published.outcome).toBe("published");
  });
});

describe("publishPost — video and reels (E5.3/E5.4)", () => {
  it("sends an image_post to publishImagePost, never to the video path", async () => {
    const h = harness();
    await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
  });

  it.each([
    ["video_post", "video"],
    ["reels", "reels"],
  ] as Array<[PostJob["format"], string]>)(
    "sends a %s job to publishVideoPost with target %s",
    async (format, target) => {
      const h = harness({
        jobs: [
          makeJob({
            format,
            media: [{ driveFileId: "drive-1", fileName: "clip.mp4", url: "https://old/clip.mp4" }],
          }),
        ],
      });

      const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

      expect(result.outcome).toBe("published");
      expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
      const input = h.publisher.publishVideoPost.mock.calls[0][0];
      expect(input).toMatchObject({ target, caption: "Giannal – MỘT NGÀY DỊU DÀNG" });
      // Freshly signed, like every other publish (E3.6).
      expect(input.videoUrl).toBe(
        `${MEDIA_BASE_URL}/api/media/drive-1?tenant=${TENANT}&expires=${h.signer.calls[0].expiresAtMs}&sig=deadbeef`,
      );
      // The anti-duplicate key carries the format, so a video and an album of
      // the same product on the same channel are different rows.
      expect(input.idempotencyKey.endsWith(`|${format}`)).toBe(true);
    },
  );

  it("warns (with the new error code) when no probe is wired in this process", async () => {
    const lines: Array<{ level: string; message: string; context?: LogContext }> = [];
    const repo = makeMemoryRepo([makeJob({ format: "reels" })]);
    const publish = makePublishPost({
      postJobs: repo,
      products: makeProducts(makeProduct("104")),
      channels: makeChannels(CHANNEL),
      tenants: makeTenants(),
      publisher: {
        publishImagePost: async () => ({ postId: "x", url: null }),
        publishVideoPost: async () => ({ postId: "555000111_5", url: null }),
      },
      queue: makeQueue(),
      progress: makeMemoryJobProgressStore(),
      clock: fixedClock(),
      logger: {
        child: () => ({
          child: () => ({}) as never,
          debug: () => {},
          info: () => {},
          warn: (message: string, context?: LogContext) =>
            lines.push({ level: "warn", message, context }),
          error: () => {},
        }) as never,
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
      signMediaUrl: fakeSigner(fixedClock()).sign,
      mediaBaseUrl: () => MEDIA_BASE_URL,
      // A reels job never reads photo bytes; wired because the dep is required.
      readMediaBytes: async () => ({ bytes: PHOTO_BYTES, mimeType: "image/jpeg" }),
    });

    await publish({ tenantId: TENANT, postJobId: "job-1" });

    const warn = lines.find((line) => line.context?.reason === "VIDEO_PROBE_NOT_WIRED");
    expect(warn?.context?.error_code).toBe("VIDEO_PROBE_FAILED");
  });
});

// --- E5.3: the video spec is re-checked before the upload -------------------

const VIDEO_ASSET: MediaAsset = {
  driveFileId: "drive-video-1",
  origin: "drive",
  storageKey: null,
  fileName: "MGKVX6310-Tím (1).mp4",
  productCode: "MGKVX6310",
  color: "TÍM",
  colorRaw: "Tím",
  sequence: 1,
  kind: "video",
  variants: { aiGenerated: false, realPhoto: true, backView: false },
  mimeType: "video/mp4",
  sizeBytes: 5_000_000,
  modifiedTime: "2026-08-01T00:00:00.000Z",
  warnings: [],
  needsReview: false,
};

/** 9:16, 12s, 30fps — inside every Reels limit. */
const GOOD_REEL_SPEC: VideoSpec = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1080,
  height: 1920,
  durationSec: 12,
  sizeBytes: 5_000_000,
  fps: 30,
};

function videoJob(overrides: Partial<PostJob> = {}): PostJob {
  return makeJob({
    format: "reels",
    media: [
      { driveFileId: "drive-video-1", fileName: "clip.mp4", url: "https://old/clip.mp4" },
    ],
    ...overrides,
  });
}

function makeAssets(asset: MediaAsset | null = VIDEO_ASSET): MediaAssetLookup {
  return { findByDriveFileId: async () => asset };
}

function makeProbe(result: VideoSpec | AppError): VideoAssetProbe {
  return {
    probeAsset: async () => {
      if (result instanceof AppError) throw result;
      return result;
    },
  };
}

describe("publishPost — video spec gate (E5.3)", () => {
  it("publishes a clip that fits the target", async () => {
    const h = harness({
      jobs: [videoJob()],
      videoProbe: makeProbe(GOOD_REEL_SPEC),
      mediaAssets: makeAssets(),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishVideoPost).toHaveBeenCalledTimes(1);
  });

  it("BLOCKS a Reel that is too short — and uploads nothing", async () => {
    const h = harness({
      jobs: [videoJob()],
      // 2 seconds: under the Reels minimum.
      videoProbe: makeProbe({ ...GOOD_REEL_SPEC, durationSec: 2 }),
      mediaAssets: makeAssets(),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("VIDEO_SPEC_INVALID");
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")).toMatchObject({
      status: "blocked",
      lastErrorCode: "VIDEO_SPEC_INVALID",
    });
    expect(result.userMessage).toMatch(/giây/);
  });

  it("blocks with VIDEO_PROBE_FAILED when the file cannot be read", async () => {
    const h = harness({
      jobs: [videoJob()],
      videoProbe: makeProbe(
        new AppError("INVALID_INPUT", {
          message: "not a video",
          context: { reason: "NOT_A_VIDEO" },
        }),
      ),
      mediaAssets: makeAssets(),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "VIDEO_PROBE_FAILED" });
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
  });

  it("blocks when the asset is not in the synced snapshot", async () => {
    const h = harness({
      jobs: [videoJob()],
      videoProbe: makeProbe(GOOD_REEL_SPEC),
      mediaAssets: makeAssets(null),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "VIDEO_PROBE_FAILED" });
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
  });

  it("publishes with a warning when ffprobe is missing in THIS process", async () => {
    const h = harness({
      jobs: [videoJob()],
      videoProbe: makeProbe(
        new AppError("INTERNAL", {
          message: "ffprobe not found",
          context: { reason: "FFPROBE_NOT_AVAILABLE" },
        }),
      ),
      mediaAssets: makeAssets(),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    // PENDING(video-gate-strictness): a missing binary must not stop the shop.
    expect(result.outcome).toBe("published");
    expect(h.publisher.publishVideoPost).toHaveBeenCalledTimes(1);
  });

  it("publishes with a warning when no probe is wired at all", async () => {
    const h = harness({ jobs: [videoJob()] });
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(result.outcome).toBe("published");
  });

  it("never probes an image post", async () => {
    let probed = 0;
    const h = harness({
      videoProbe: {
        probeAsset: async () => {
          probed += 1;
          return GOOD_REEL_SPEC;
        },
      },
      mediaAssets: makeAssets(),
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(probed).toBe(0);
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
  });

  it("measures a feed video against the VIDEO limits, not the Reels ones", async () => {
    // 16:9, 45s: fine for a feed video, wrong aspect for Reels.
    const landscape: VideoSpec = {
      ...GOOD_REEL_SPEC,
      width: 1920,
      height: 1080,
      durationSec: 45,
    };
    const feed = harness({
      jobs: [videoJob({ format: "video_post" })],
      videoProbe: makeProbe(landscape),
      mediaAssets: makeAssets(),
    });
    expect((await feed.publish({ tenantId: TENANT, postJobId: "job-1" })).outcome).toBe("published");

    const reel = harness({
      jobs: [videoJob({ format: "reels" })],
      videoProbe: makeProbe(landscape),
      mediaAssets: makeAssets(),
    });
    const blocked = await reel.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(blocked).toMatchObject({ outcome: "blocked", errorCode: "VIDEO_SPEC_INVALID" });
  });
});

// --- E6: one publisher per platform -----------------------------------------

const TIKTOK_CHANNEL: ChannelConfig = {
  channelId: "tiktok-shop",
  platform: "tiktok",
  name: "Shop TikTok",
  externalId: "open-id-1",
  accessToken: "act.secret",
  status: "active",
  tokenExpiresAt: null,
  tiktok: { privacyLevel: "SELF_ONLY", isAigc: true, openId: "open-id-1" },
};

describe("publishPost — platform routing (E6)", () => {
  function tiktokSpy() {
    return {
      publishImagePost: vi.fn(async () => ({ postId: "never", url: null })),
      publishVideoPost: vi.fn(async () => ({ postId: "v_pub_1", url: null })),
    };
  }

  it("sends a TikTok channel's video to the TikTok publisher, not to Facebook", async () => {
    const tiktok = tiktokSpy();
    const h = harness({
      jobs: [
        makeJob({
          format: "video_post",
          channelId: "tiktok-shop",
          media: [{ driveFileId: "drive-1", fileName: "clip.mp4", url: "https://old/clip.mp4" }],
        }),
      ],
      channel: TIKTOK_CHANNEL,
      publishers: { tiktok },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "published", publishedPostId: "v_pub_1" });
    expect(tiktok.publishVideoPost).toHaveBeenCalledTimes(1);
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("keeps sending Facebook channels to the Facebook publisher", async () => {
    const tiktok = tiktokSpy();
    const h = harness({ publishers: { tiktok } });
    await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(tiktok.publishVideoPost).not.toHaveBeenCalled();
  });

  it("passes the probed duration to the publisher (TikTok checks it per account)", async () => {
    const tiktok = tiktokSpy();
    const h = harness({
      jobs: [
        makeJob({
          format: "video_post",
          channelId: "tiktok-shop",
          media: [{ driveFileId: "drive-video-1", fileName: "clip.mp4", url: "https://old/c.mp4" }],
        }),
      ],
      channel: TIKTOK_CHANNEL,
      publishers: { tiktok },
      videoProbe: {
        probeAsset: async () => ({
          container: "mov,mp4,m4a,3gp,3g2,mj2",
          videoCodec: "h264",
          audioCodec: "aac",
          width: 1080,
          height: 1920,
          durationSec: 42,
          sizeBytes: 5_000_000,
          fps: 30,
        }),
      },
      mediaAssets: { findByDriveFileId: async () => VIDEO_ASSET },
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const [videoInput] = tiktok.publishVideoPost.mock.calls[0] as unknown as [
      { durationSec: number },
    ];
    expect(videoInput).toMatchObject({ durationSec: 42 });
  });

  it("blocks when no publisher is wired for the channel's platform", async () => {
    const h = harness({
      jobs: [makeJob({ channelId: "tiktok-shop" })],
      channel: TIKTOK_CHANNEL,
      // publishers.tiktok missing on purpose.
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "CHANNEL_NOT_CONFIGURED" });
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });
});

/**
 * E8.6 — the handoff. The clock is fixed at 02:00Z, so every hour below is
 * written as an offset from it: T-20 is inside the window, T-40 is before it,
 * T-5 is past the deadline.
 */
describe("publishPost — handing a scheduled post to Facebook (E8.6)", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");
  const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

  // --- Edge cases first ------------------------------------------------------

  it("does NOT hand over before the window opens — it comes back at T-30", async () => {
    const h = harness({ jobs: [makeJob({ scheduledAt: at(40 * 60_000), queueJobId: "pp.job-1" })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(10 * 60_000);
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    // Nothing was claimed: the row is exactly where it was.
    expect(h.repo.get("job-1")?.status).toBe("queued");
    expect(h.queue.enqueued[0]?.opts?.delayMs).toBe(10 * 60_000);
  });

  it("does NOT hand over inside the last 12 minutes — it waits for the hour", async () => {
    // Facebook needs ~10 minutes of lead and an album upload can take minutes,
    // so a handoff here would be refused; publishing early would surprise the
    // operator. Waiting for T is the only honest answer.
    const h = harness({ jobs: [makeJob({ scheduledAt: at(5 * 60_000), queueJobId: "pp.job-1" })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(5 * 60_000);
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.status).toBe("queued");
  });

  it("checks the stock BEFORE the handoff — a sold-out post never reaches Facebook", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000) })],
      product: makeProduct("0"),
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("OUT_OF_STOCK");
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.status).toBe("blocked");
  });

  it("re-running a job Facebook already holds sends NOTHING (crash between handoff and status)", async () => {
    const h = harness({
      jobs: [
        makeJob({
          status: "scheduled_on_facebook",
          scheduledAt: at(20 * 60_000),
          scheduledPostId: "555000111_scheduled",
        }),
      ],
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("skipped");
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.status).toBe("scheduled_on_facebook");
  });

  // --- Happy path ------------------------------------------------------------

  it("hands the post over inside the window and lands in `scheduled_on_facebook`, NOT `published`", async () => {
    const scheduledAt = at(20 * 60_000);
    const h = harness({ jobs: [makeJob({ scheduledAt })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("scheduled_on_facebook");
    expect(result.scheduledPostId).toBe("555000111_scheduled");
    expect(result.publishedPostId).toBeNull();
    // The album travelled, but nothing was PUBLISHED.
    expect(h.publisher.scheduled?.schedulePost).toHaveBeenCalledTimes(1);
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();

    const handed = h.publisher.scheduled?.schedulePost.mock.calls[0]?.[0] as SchedulePostInput;
    expect(handed.publishAt).toEqual(scheduledAt);
    expect(handed.media).toHaveLength(1);
    expect(handed.caption).toBe("Giannal – MỘT NGÀY DỊU DÀNG");

    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("scheduled_on_facebook");
    expect(stored?.scheduledPostId).toBe("555000111_scheduled");
    expect(stored?.publishedPostId).toBeNull();
    expect(stored?.publishedAt).toBeNull();
    // The queue is done with this job: Facebook owns the hour now.
    expect(stored?.queueJobId).toBeNull();

    const handoff = h.repo.transitionInputs.find(
      (input) => input.next.status === "scheduled_on_facebook",
    );
    expect(handoff?.auditAction).toBe("post_job.scheduled_on_facebook");
    // The audit row of the moment the post was CREATED on Facebook must carry
    // its id: the default payload only has `published_post_id`, which is null
    // here, so this event would otherwise leave nothing to search the Page with.
    // `scheduled_at` is the repo's own field (it merges this payload UNDER its
    // own), so it is deliberately not passed from here.
    expect(handoff?.auditPayload).toEqual({
      scheduled_post_id: "555000111_scheduled",
      lead_ms: 20 * 60_000,
    });
  });

  it("publishes on the normal path — and says so — when the hour has already passed", async () => {
    const h = harness({ jobs: [makeJob({ scheduledAt: at(-90_000) })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    const published = h.repo.transitionInputs.find((input) => input.next.status === "published");
    expect(published?.auditAction).toBe("post_job.published_late");
    expect(published?.reason).toBe("PUBLISHED_LATE");
  });

  it("keeps an immediate post on the normal path with no late marker (regression)", async () => {
    const h = harness({ jobs: [makeJob({ scheduledAt: null })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(h.publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    const published = h.repo.transitionInputs.find((input) => input.next.status === "published");
    expect(published?.auditAction).toBeUndefined();
  });

  // --- Failed handoffs -------------------------------------------------------

  it("tries again inside the window after a transient failure that created nothing", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(30 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        // A rate limit WHILE UPLOADING the album: the creating call never went
        // out, so repeating the handoff cannot duplicate anything.
        throw new AppError("META_ERROR", {
          message: "Graph is having a moment",
          context: { retryable: true, platform_created_nothing: true },
        });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    // 5 minutes later, which still leaves more than the 12-minute deadline.
    expect(result.deferredMs).toBe(5 * 60_000);
    expect(h.queue.enqueued[0]?.opts?.delayMs).toBe(5 * 60_000);
    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("queued");
    expect(stored?.lastErrorMessage).toContain("thử lại trước giờ đăng");
  });

  it("falls back to publishing AT the hour when no attempt fits any more", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(14 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("META_ERROR", {
          message: "Graph is having a moment",
          context: { retryable: true, platform_created_nothing: true },
        });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    // Wakes exactly at T and publishes there, instead of dropping the post.
    expect(result.deferredMs).toBe(14 * 60_000);
    expect(result.errorCode).toBe("HANDOFF_EXPIRED");
    expect(h.repo.get("job-1")?.status).toBe("queued");
  });

  /**
   * BEHAVIOUR CHANGE: a refusal that created NOTHING on the Page no longer ends
   * as `failed`. Facebook answers #100 to a `scheduled_publish_time` under its
   * ~10-minute minimum, and the window between the handoff deadline (T-12) and
   * that minimum (T-10) is about two minutes — less than a slow 10-photo album
   * upload. Dropping the post there was wrong: the "wait for T, publish
   * normally" path is untouched and cannot double-post, because the platform
   * holds nothing.
   */
  it("publishes at the hour instead of failing when the refusal created NOTHING", async () => {
    const scheduledAt = at(20 * 60_000);
    const h = harness({
      jobs: [makeJob({ scheduledAt, queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("META_ERROR", {
          message: "Graph API error code=100 message=scheduled publish time is invalid",
          userMessage: "Facebook từ chối dữ liệu bài đăng.",
          context: { retryable: false, platform_created_nothing: true },
        });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    // Wakes exactly at T and publishes on the normal path.
    expect(result.deferredMs).toBe(20 * 60_000);
    expect(result.errorCode).toBe("HANDOFF_REFUSED");
    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("queued");
    expect(stored?.lastErrorMessage).toContain("đăng thẳng vào giờ đã hẹn");
    expect(h.queue.enqueued[0]?.opts?.delayMs).toBe(20 * 60_000);
  });

  it("does the same for the adapter's own pre-upload refusal (giờ hẹn quá gần)", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(13 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("INVALID_INPUT", {
          message: "schedulePost needs at least 600000ms of lead",
          userMessage: "Giờ hẹn quá gần (Facebook đòi tối thiểu ~10 phút).",
          context: {
            reason: "PUBLISH_AT_TOO_SOON",
            retryable: false,
            platform_created_nothing: true,
          },
        });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(13 * 60_000);
    expect(h.repo.get("job-1")?.status).toBe("queued");
    // The job is NOT failed: nothing was ever created on the Page.
    expect(h.repo.get("job-1")?.lastErrorCode).toBe("HANDOFF_REFUSED");
  });

  it("does NOT retry an unreadable answer — a second handoff could double-post", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000) })],
      schedulePost: async () => {
        throw new AppError("META_ERROR", {
          message: "Graph answered feed.scheduled without a usable id",
          context: { retryable: false, feed_dispatched: true },
        });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "META_ERROR",
    });

    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.lastErrorCode).toBe("HANDOFF_FAILED");
    expect(stored?.lastErrorMessage).toContain("bài đã lên lịch");
    expect(h.queue.enqueued).toHaveLength(0);
  });

  /**
   * B1 REGRESSION (gate on 28916c6). `retryable` says whether the CALL could
   * work later; it never says whether repeating it is safe. A timeout on the
   * creating request is retryable AND may have left a scheduled post on the
   * Page — retrying it, or waking up at the hour to publish normally, is how a
   * job ends up posting twice in the same minute.
   */
  it("stops the job when a RETRYABLE failure left the outcome unknown", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(30 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("META_ERROR", {
          message: "Graph API error http=504",
          userMessage: "Không kết nối được tới Facebook — hệ thống sẽ thử lại.",
          context: { retryable: true, feed_dispatched: true },
        });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "META_ERROR",
    });

    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.lastErrorCode).toBe("HANDOFF_FAILED");
    expect(stored?.lastErrorMessage).toContain("CÓ THỂ đã được tạo trên Trang");
    // Neither another handoff nor a wake-up at the hour was scheduled.
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("stops the job when the publisher promises nothing at all", async () => {
    // No flag either way: the port says the caller must then assume a post may
    // exist. A TikTok-style publisher that has not adopted the flags must not
    // silently get the old "retry it" behaviour.
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(30 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("META_ERROR", { message: "who knows", context: { retryable: true } });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "META_ERROR",
    });
    expect(h.repo.get("job-1")?.status).toBe("failed");
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("gives the job back to the queue when the window closes while it is prepared", async () => {
    // The stock recheck and the channel read take real time; a handoff that
    // drifted past T-12 must not be attempted (Facebook would refuse it after a
    // full album upload).
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(13 * 60_000), queueJobId: "pp.job-1" })],
    });
    h.publisher.scheduled?.schedulePost.mockImplementation(async () => {
      throw new Error("the handoff must not be attempted once the window closed");
    });
    // The claim succeeds at T-13 (inside the window), then two minutes of stock
    // and channel lookups pass: by the call it would be T-11, below the deadline.
    const applyTransition = h.repo.applyTransition.bind(h.repo);
    h.repo.applyTransition = async (input) => {
      const next = await applyTransition(input);
      if (input.next.status === "publishing") h.clock.advance(2 * 60_000);
      return next;
    };

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    // Back to `queued`, so the next wake-up publishes it at the hour.
    expect(h.repo.get("job-1")?.status).toBe("queued");
    expect(h.repo.transitions.map((entry) => entry.to)).toEqual(["publishing", "queued"]);
  });

  it("blocks on a dead token found BEFORE anything was dispatched", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000) })],
      schedulePost: async () => {
        // The album upload got the 190: /feed was never called, so the Page
        // provably holds nothing and `blocked` is the honest answer.
        throw new AppError("TOKEN_EXPIRED", {
          message: "token gone",
          context: { step: "photos.album", platform_created_nothing: true },
        });
      },
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(result.errorCode).toBe("TOKEN_EXPIRED");
    expect(h.repo.get("job-1")?.status).toBe("blocked");
  });

  /**
   * Gate note 3. TOKEN_EXPIRED used to be routed by CODE, before the "does the
   * platform hold anything?" gate. A 190/OAuthException answered to a /feed that
   * HAS left this process says the token is dead; it says nothing about whether
   * an earlier attempt of this job already created the scheduled post. Blocking
   * there parked the row in `blocked` — a status "Chạy lại" accepts — behind a
   * message that never mentioned the Page. That is the same inference from a
   * Graph error body that #506 already taught us not to make.
   */
  it("does NOT block on a dead token reported by the DISPATCHED /feed", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("TOKEN_EXPIRED", {
          message: "Graph API error code=190",
          context: { step: "feed.scheduled", feed_dispatched: true },
        });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });

    const stored = h.repo.get("job-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.lastErrorCode).toBe("HANDOFF_FAILED");
    // The operator is told about BOTH facts: the dead token and the post that
    // may be waiting on the Page.
    expect(stored?.lastErrorMessage).toContain("CÓ THỂ đã được tạo trên Trang");
    expect(stored?.lastErrorMessage).toContain("Token");
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("fails closed on a dead token with no proof either way", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000), queueJobId: "pp.job-1" })],
      schedulePost: async () => {
        throw new AppError("TOKEN_EXPIRED", { message: "token gone" });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
    expect(h.repo.get("job-1")?.status).toBe("failed");
    expect(h.repo.get("job-1")?.lastErrorCode).toBe("HANDOFF_FAILED");
  });

  it("waits for the hour on a platform that cannot hold a post (no scheduler)", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(20 * 60_000), queueJobId: "pp.job-1" })],
      withoutScheduler: true,
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(20 * 60_000);
    expect(h.publisher.publishImagePost).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.status).toBe("queued");
  });

  it("never hands a VIDEO over — it waits for the hour like before E8.6", async () => {
    const h = harness({
      jobs: [
        makeJob({ format: "video_post", scheduledAt: at(20 * 60_000), queueJobId: "pp.job-1" }),
      ],
    });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.deferredMs).toBe(20 * 60_000);
    expect(h.publisher.scheduled?.schedulePost).not.toHaveBeenCalled();
    expect(h.publisher.publishVideoPost).not.toHaveBeenCalled();
  });
});

/**
 * E7.5 — the progress this usecase reports (design §5.6).
 *
 * The rule under every test here: progress is DECORATION (design §3.1). It must
 * describe the run truthfully, and it must never be able to change its outcome.
 */
describe("publishPost — progress reporting (E7.5)", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");
  const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

  /** A publisher that emits the events the real Facebook adapter emits. */
  const albumPublisher = (fileNames: readonly string[]) =>
    async (input: PublishImagePostInput) => {
      fileNames.forEach((fileName, index) => {
        input.onProgress?.({
          kind: "media_upload_started",
          index,
          total: fileNames.length,
          fileName,
        });
        input.onProgress?.({
          kind: "media_upload_finished",
          index,
          total: fileNames.length,
          fileName,
        });
      });
      input.onProgress?.({ kind: "creating_post" });
      return { postId: "555000111_1", url: "https://fb/555000111_1" };
    };

  // --- Edge cases first ------------------------------------------------------

  it("publishes the post even when EVERY progress write throws", async () => {
    const h = harness({
      progress: makeThrowingJobProgressStore(),
      publish: albumPublisher(["1.jpg"]),
    });
    // The durable half is broken too: a telemetry INSERT may not fail a post.
    h.repo.appendJobEvent = async () => {
      throw new AppError("DB_ERROR", { message: "post_job_event is unreachable" });
    };

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(h.repo.get("job-1")?.status).toBe("published");
  });

  it("reports nothing for a job it refuses to touch (already published)", async () => {
    const h = harness({
      jobs: [makeJob({ status: "published", publishedPostId: "555000111_1" })],
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.progress.stages()).toEqual([]);
    expect(h.progress.cleared).toEqual([]);
    expect(h.repo.events).toEqual([]);
  });

  // --- Each milestone of the design table ------------------------------------

  it("reports the spacing wait with the deadline the gate computed", async () => {
    const published = makeJob({
      id: "job-0",
      channelId: "fbpage-a",
      status: "published",
      publishedAt: new Date(NOW - 10_000),
    });
    const h = harness({
      jobs: [published, makeJob({ id: "job-1" })],
      settings: { spacingMs: 60_000 },
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const report = h.progress.reports.at(-1);
    expect(report?.progress.stage).toBe("waiting_for_spacing");
    // 60s spacing, 10s already elapsed -> a REAL deadline 50s from now.
    expect(report?.progress.waitUntil).toEqual(at(50_000));
    expect(report?.progress.doneCount).toBeNull();
    expect(h.repo.events).toMatchObject([
      { stage: "waiting_for_spacing", detail: { wait_ms: 50_000, spacing_ms: 60_000 } },
    ]);
  });

  it("reports the wait for the handoff window with the instant it wakes up at", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: at(40 * 60_000), queueJobId: "pp.job-1" })],
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    const report = h.progress.reports.at(-1);
    expect(report?.progress.stage).toBe("waiting_for_schedule");
    // The window opens at T-30, i.e. 10 minutes from now.
    expect(report?.progress.waitUntil).toEqual(at(10 * 60_000));
  });

  it("walks the stock check, the channel read, every photo and the send", async () => {
    const h = harness({ publish: albumPublisher(["1.jpg", "2.jpg", "3.jpg"]) });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.progress.stages()).toEqual([
      "checking_stock",
      "reading_channel",
      // started(0) / finished(1) for each of the three photos...
      "uploading_media",
      "uploading_media",
      "uploading_media",
      "uploading_media",
      "uploading_media",
      "uploading_media",
      "sending_to_channel",
    ]);

    const uploads = h.progress.reports.filter(
      (entry) => entry.progress.stage === "uploading_media",
    );
    expect(uploads.map((entry) => `${entry.progress.doneCount}/${entry.progress.totalCount}`)).toEqual([
      "0/3",
      "1/3",
      "1/3",
      "2/3",
      "2/3",
      "3/3",
    ]);
    expect(uploads[0].progress.currentItem).toBe("1.jpg");
  });

  it("writes ONE durable row per stage change, never one per photo (§5.4)", async () => {
    const h = harness({ publish: albumPublisher(["1.jpg", "2.jpg", "3.jpg"]) });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.repo.events.map((event) => event.stage)).toEqual([
      "checking_stock",
      "reading_channel",
      "uploading_media",
      "sending_to_channel",
      "done",
    ]);
    for (const event of h.repo.events) {
      expect(event.tenantId).toBe(TENANT);
      expect(event.postJobId).toBe("job-1");
      expect(event.batchId).toBe("batch-1");
      expect(event.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("reports the video spec gate before anything is uploaded", async () => {
    const h = harness({
      jobs: [makeJob({ format: "reels" })],
      publishVideo: async () => ({ postId: "555000111_5", url: null }),
    });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.progress.stages().slice(0, 3)).toEqual([
      "checking_stock",
      "reading_channel",
      "checking_video_spec",
    ]);
  });

  it("reports the handoff, then the wait Facebook now owns", async () => {
    const scheduledAt = at(20 * 60_000);
    const h = harness({ jobs: [makeJob({ scheduledAt })] });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("scheduled_on_facebook");
    expect(h.progress.stages()).toEqual([
      "checking_stock",
      "reading_channel",
      "handing_to_facebook",
      "waiting_on_facebook",
    ]);
    const waiting = h.progress.reports.at(-1)?.progress;
    // The deadline is the scheduled hour itself — a fact, not an estimate.
    expect(waiting?.waitUntil).toEqual(scheduledAt);
    // Facebook holds the post; the key is NOT cleared, and the reading usecase
    // hides it anyway once the status leaves queued/publishing (§3.1).
    expect(h.progress.cleared).toEqual([]);
  });

  // --- The end of a job ------------------------------------------------------

  it("closes a published job with `done` and drops the hot key", async () => {
    const h = harness({ publish: albumPublisher(["1.jpg"]) });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(h.repo.events.at(-1)).toMatchObject({
      stage: "done",
      detail: { status: "published", published_post_id: "555000111_1" },
    });
    expect(h.progress.cleared).toEqual(["job-1"]);
    expect(h.progress.latest("job-1")).toBeUndefined();
  });

  it("closes a job blocked by the stock recheck with `stopped`", async () => {
    const h = harness({ product: makeProduct("0") });

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("blocked");
    expect(h.repo.events.at(-1)).toMatchObject({
      stage: "stopped",
      detail: { status: "blocked", error_code: "OUT_OF_STOCK" },
    });
    expect(h.progress.cleared).toEqual(["job-1"]);
  });

  it("closes a failed job with `stopped` too", async () => {
    const h = harness({
      publish: async () => {
        throw new AppError("META_ERROR", {
          message: "Graph refused",
          context: { retryable: false, platform_created_nothing: true },
        });
      },
    });

    await expect(h.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
    });

    expect(h.repo.events.at(-1)).toMatchObject({ stage: "stopped", detail: { status: "failed" } });
    expect(h.progress.cleared).toEqual(["job-1"]);
  });

  it("never leaves an upload report behind after the key was cleared", async () => {
    const h = harness({ publish: albumPublisher(["1.jpg", "2.jpg"]) });

    await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    // Everything the publisher emitted landed BEFORE the clear, so a finished
    // job can never be shown as "đang tải ảnh 1/2".
    expect(h.progress.latest("job-1")).toBeUndefined();
    const lastReportedStage = h.progress.stages().at(-1);
    expect(lastReportedStage).toBe("sending_to_channel");
  });

  it("carries the attempt number into both halves", async () => {
    const h = harness({ publish: albumPublisher(["1.jpg"]) });

    await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });

    expect(h.progress.reports[0]?.progress.attempt).toBe(2);
    expect(h.repo.events[0]?.attempt).toBe(2);
  });
});

/**
 * Onboarding phase 3 — the product text was TYPED by an operator on the compose
 * screen (`product.origin = "manual"`), not synced from a catalog.
 *
 * The point of these cases is the SEAM, which is where CLAUDE.md says the bugs
 * live: composing writes a manual row, publishing re-reads it by code, and
 * business rule 3 must run on that row exactly as it does on a synced one. A
 * manual product is not an exception to the stock gate, and nothing in
 * `publishPost` may start filtering by origin — `findByCode` returning the
 * typed row IS the contract (proven against Postgres in
 * adapters/db/product-repo.manual.write.integration.test.ts).
 */
function manualProduct(stockRaw: string, noteRaw = ""): Product {
  return { ...makeProduct(stockRaw, noteRaw), origin: "manual" };
}

/**
 * A product port whose answer CHANGES between reads, plus the log of what was
 * asked. One fixed answer cannot express "còn hàng lúc soạn, hết hàng lúc
 * đăng", and that gap is the only reason the second check exists.
 */
function sequencedProducts(answers: readonly (Product | null)[]): ProductRepo & {
  reads: Array<{ tenantId: string; code: string }>;
} {
  const reads: Array<{ tenantId: string; code: string }> = [];
  return {
    reads,
    findByCode: async (tenantId: string, code: string) => {
      reads.push({ tenantId, code });
      // The last answer repeats: a test asserting on ONE read must not depend
      // on how many times something else reads afterwards.
      return answers[Math.min(reads.length - 1, answers.length - 1)] ?? null;
    },
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 1,
  };
}

describe("publishPost — stock recheck on a MANUAL product (phase 3, business rule 3)", () => {
  it("re-reads the typed row by code and publishes when the operator's number allows it", async () => {
    const products = sequencedProducts([manualProduct("2")]);
    const { publish, publisher, repo } = harness({ products });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    // The recheck happened, on THIS tenant's row for THIS code — no origin
    // filter, no second lookup path for typed data.
    expect(products.reads).toEqual([{ tenantId: TENANT, code: "MGKVX6310" }]);
    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(repo.get("job-1")?.status).toBe("published");
  });

  it("judges the typed number itself: 2 goes out, 0 does not, same product otherwise", async () => {
    const inStock = harness({ products: sequencedProducts([manualProduct("2")]) });
    const soldOut = harness({ products: sequencedProducts([manualProduct("0")]) });

    const first = await inStock.publish({ tenantId: TENANT, postJobId: "job-1" });
    const second = await soldOut.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(first.outcome).toBe("published");
    expect(second).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(soldOut.publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it.each([
    ["a typed zero", "0", ""],
    ["an empty stock field", "", ""],
    ["a stock field that is not a number", "chưa rõ", ""],
    ["the sold-out note, whatever the number says", "50", "HẾT HÀNG"],
  ])("blocks %s BEFORE the channel is called", async (_case, stockRaw, noteRaw) => {
    const { publish, publisher, repo } = harness({
      products: sequencedProducts([manualProduct(stockRaw, noteRaw)]),
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(publisher.publishVideoPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")).toMatchObject({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" });
    expect(result.userMessage ?? "").not.toBe("");
  });

  it("blocks a typed row that disappeared before the publish call", async () => {
    // The operator deleted it, or a later sync replaced the code with a synced
    // row that was then swept: either way the post must not go out.
    const { publish, publisher, repo } = harness({ products: sequencedProducts([null]) });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "PRODUCT_NOT_FOUND" });
    expect(repo.get("job-1")?.status).toBe("blocked");
  });

  it("blocks when the typed stock ran out BETWEEN composing and publishing", async () => {
    // Read 1 stands for the compose/create-batch gate: it saw 104 and the job
    // was legitimately queued (create-post-batch.test.ts owns that half). Read 2
    // is the publish-time recheck, and by then the operator has edited the row
    // down to zero. Nothing about the job changed — only the catalog did.
    const products = sequencedProducts([manualProduct("104"), manualProduct("0")]);
    const composeTime = await products.findByCode(TENANT, "MGKVX6310");
    expect(composeTime?.operational.stockRaw).toBe("104");

    const lines: LogLine[] = [];
    const { publish, publisher, repo } = harness({ products, lines });
    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(products.reads).toHaveLength(2);
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")).toMatchObject({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" });
    // The log must say which number blocked it — the compose-time one is gone,
    // and "vì sao bài này không lên" has to be answerable from this line alone.
    const blocked = lines.find((line) => line.context?.error_code === "OUT_OF_STOCK");
    expect(blocked?.context).toMatchObject({ stock: 0, outcome: "blocked" });
  });

  it("keeps the SCHEDULED variant honest too: a typed row that sold out is auto-cancelled", async () => {
    // E8.3 — same gate, different bookkeeping: an hours-old scheduled post that
    // the recheck kills must show up as a withdrawal, not a silent no-op.
    const scheduled = makeJob({ scheduledAt: new Date("2026-08-13T01:59:00.000Z") });
    const { publish, publisher, repo } = harness({
      jobs: [scheduled],
      products: sequencedProducts([manualProduct("0")]),
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(publisher.publishImagePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(repo.get("job-1")?.status).toBe("blocked");
  });

  it("the tenant's policy is what suspends the gate — being typed by hand never is", async () => {
    // `disabled` lets an empty stock cell through, for a manual row exactly as
    // for a synced one, and the run says out loud that NOBODY checked.
    const lines: LogLine[] = [];
    const { publish, publisher } = harness({
      products: sequencedProducts([manualProduct("")]),
      stockPolicy: DISABLED_POLICY,
      lines,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("published");
    expect(publisher.publishImagePost).toHaveBeenCalledTimes(1);
    expect(
      lines.some(
        (line) => line.level === "warn" && line.context?.stock_check_skipped === true,
      ),
    ).toBe(true);
  });

  it("but a disabled policy still blocks the sold-out NOTE on a typed row", async () => {
    const { publish, publisher } = harness({
      products: sequencedProducts([manualProduct("", "HẾT HÀNG")]),
      stockPolicy: DISABLED_POLICY,
    });

    const result = await publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result).toMatchObject({ outcome: "blocked", errorCode: "OUT_OF_STOCK" });
    expect(publisher.publishImagePost).not.toHaveBeenCalled();
  });

  it("textual policy reads the operator's WORDING on a typed row", async () => {
    const inStock = harness({
      products: sequencedProducts([manualProduct("Còn hàng")]),
      stockPolicy: TEXTUAL_POLICY,
    });
    const outOfStock = harness({
      products: sequencedProducts([manualProduct("Hết hàng")]),
      stockPolicy: TEXTUAL_POLICY,
    });

    expect((await inStock.publish({ tenantId: TENANT, postJobId: "job-1" })).outcome).toBe(
      "published",
    );
    expect(await outOfStock.publish({ tenantId: TENANT, postJobId: "job-1" })).toMatchObject({
      outcome: "blocked",
      errorCode: "OUT_OF_STOCK",
    });
    expect(outOfStock.publisher.publishImagePost).not.toHaveBeenCalled();
  });
});
