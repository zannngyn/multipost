import { randomUUID } from "node:crypto";

import { makeSystemClock } from "@/adapters/clock/system-clock";
import { DrizzleCatalogConfigRepo } from "@/adapters/db/catalog-config-repo.drizzle";
import { DrizzleChannelConfigRepo } from "@/adapters/db/channel-config-repo.drizzle";
import { closeDbHandle, getDbHandle, type Database } from "@/adapters/db/client";
import { DrizzleMediaRepo } from "@/adapters/db/media-repo.drizzle";
import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import { DrizzleProductRepo } from "@/adapters/db/product-repo.drizzle";
import { DrizzleSyncRunRepo } from "@/adapters/db/sync-run-repo.drizzle";
import { DrizzleTenantRepo } from "@/adapters/db/tenant-repo.drizzle";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { makeFacebookPublisher } from "@/adapters/meta/facebook-publisher";
import { makeGraphClient } from "@/adapters/meta/graph-client";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import type { DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { ChannelPublisher } from "@/core/ports/publisher";
import type { SheetSource } from "@/core/ports/sheet-source";
import { makeComposePost, type ComposePost } from "@/core/usecases/compose-post";
import { makeCreatePostBatch, type CreatePostBatch } from "@/core/usecases/create-post-batch";
import { makeGetSyncStatus, type GetSyncStatus } from "@/core/usecases/get-sync-status";
import { makeHealthcheckTenant, type HealthcheckTenant } from "@/core/usecases/healthcheck-tenant";
import { makePublishPost, type PublishPost } from "@/core/usecases/publish-post";
import { makeSyncCatalog, type SyncCatalog } from "@/core/usecases/sync-catalog";

import { makeLazyGenerateCaptions, type GenerateCaptions } from "./ai-engine";
import { loadConfig, loadMetaConfig, type Config } from "./config";
import { makeLazyGoogleSources } from "./google-sources";

/**
 * Composition root — the ONLY place that knows both core and adapters.
 */

export interface Infra {
  config: Config;
  logger: Logger;
  clock: Clock;
  db: Database;
}

export interface Usecases {
  healthcheckTenant: HealthcheckTenant;
  syncCatalog: SyncCatalog;
  getSyncStatus: GetSyncStatus;
  composePost: ComposePost;
  generateCaptions: GenerateCaptions;
  /** E7.2 — fan a post out to N channels (called by the web API). */
  createPostBatch: CreatePostBatch;
  /** E7.4 — publish one job on one channel (called by the worker). */
  publishPost: PublishPost;
}

/**
 * Injection seam for everything that talks to the outside world. Production
 * leaves it empty (the real adapters are built lazily); scripts and integration
 * tests pass the fixture sources of `sample-data/`, the worker's own queue, and
 * the FakeChannelPublisher — which is how the whole publish flow is verified
 * without a Facebook Page token.
 */
export interface UsecaseOverrides {
  drive?: DriveSource;
  sheet?: SheetSource;
  /** Worker passes its own queue so one process holds ONE Redis connection. */
  queue?: JobQueue;
  publisher?: ChannelPublisher;
}

export interface Container extends Infra {
  usecases: Usecases;
}

export interface InfraOptions {
  /** pino `service` binding. Web and worker share this wiring, not their logs. */
  serviceName?: string;
}

export function makeInfra(config: Config, options: InfraOptions = {}): Infra {
  const logger = makePinoLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    base: { service: options.serviceName ?? "mysp", env: config.NODE_ENV },
  });
  const { db } = getDbHandle({ url: config.DATABASE_URL });
  return { config, logger, clock: makeSystemClock(), db };
}

/**
 * Producer-side queue for a process that is not the worker (the web app
 * enqueueing a publish job). Lazy for the same reason as the Google/AI wiring:
 * `next build` and a page render must not need a reachable Redis.
 */
function makeLazyJobQueue(config: Config, logger: Logger): JobQueue {
  let real: JobQueue | null = null;
  let closer: (() => Promise<void>) | null = null;

  const build = (): JobQueue => {
    if (real) return real;
    const connection = createRedisConnection({ url: config.REDIS_URL, logger });
    const queue = makeBullMqJobQueue({ connection, logger });
    real = queue;
    closer = async () => {
      await queue.close();
      await connection.quit();
    };
    lazyQueueClosers.add(() => (closer ? closer() : Promise.resolve()));
    return queue;
  };

  return {
    enqueue: (jobName, payload, opts) => build().enqueue(jobName, payload, opts),
    close: async () => {
      if (closer) await closer();
      real = null;
      closer = null;
    },
  };
}

/** Closers of lazily built queues, drained by closeContainer(). */
const lazyQueueClosers = new Set<() => Promise<void>>();

/**
 * Facebook publisher, built on first use — same contract as the Google/AI
 * wiring: only a process that actually publishes reads META_GRAPH_VERSION.
 */
function makeLazyPublisher(logger: Logger): ChannelPublisher {
  let real: ChannelPublisher | null = null;
  const build = (): ChannelPublisher => {
    real ??= makeFacebookPublisher({
      graph: makeGraphClient({ logger, version: loadMetaConfig().META_GRAPH_VERSION }),
      logger,
    });
    return real;
  };
  return { publishImagePost: (input) => build().publishImagePost(input) };
}

export function makeUsecases(deps: Infra, overrides: UsecaseOverrides = {}): Usecases {
  const tenants = new DrizzleTenantRepo(deps.db);
  const products = new DrizzleProductRepo(deps.db);
  const media = new DrizzleMediaRepo(deps.db);
  const syncRuns = new DrizzleSyncRunRepo(deps.db);
  const catalogConfig = new DrizzleCatalogConfigRepo(deps.db);
  const postJobs = new DrizzlePostJobRepo(deps.db);
  const channels = new DrizzleChannelConfigRepo(deps.db);
  const google = makeLazyGoogleSources({ logger: deps.logger });
  const queue = overrides.queue ?? makeLazyJobQueue(deps.config, deps.logger);
  const publisher = overrides.publisher ?? makeLazyPublisher(deps.logger);

  return {
    healthcheckTenant: makeHealthcheckTenant({
      tenants,
      clock: deps.clock,
      logger: deps.logger,
    }),
    syncCatalog: makeSyncCatalog({
      drive: overrides.drive ?? google.drive,
      sheet: overrides.sheet ?? google.sheet,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock: deps.clock,
      logger: deps.logger,
    }),
    getSyncStatus: makeGetSyncStatus({ syncRuns, logger: deps.logger }),
    composePost: makeComposePost({ products, media, logger: deps.logger }),
    generateCaptions: makeLazyGenerateCaptions({ logger: deps.logger, clock: deps.clock }),
    createPostBatch: makeCreatePostBatch({
      postJobs,
      products,
      channels,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      newId: () => randomUUID(),
    }),
    publishPost: makePublishPost({
      postJobs,
      products,
      channels,
      publisher,
      queue,
      clock: deps.clock,
      logger: deps.logger,
    }),
  };
}

export function makeContainer(
  config: Config = loadConfig(),
  overrides: UsecaseOverrides = {},
): Container {
  const infra = makeInfra(config);
  return { ...infra, usecases: makeUsecases(infra, overrides) };
}

let cached: Container | null = null;

/**
 * Lazy singleton for long-lived processes (Next server, worker).
 * Fails fast on bad config the first time it is touched — not at import time,
 * so `next build` does not require a full production env.
 */
export function getContainer(): Container {
  if (!cached) cached = makeContainer();
  return cached;
}

/**
 * Drains the DB pool and any lazily built producer queue. For scripts and
 * graceful shutdown, not per request. (The worker's own queue/connection is
 * owned and closed by worker-container.)
 */
export async function closeContainer(): Promise<void> {
  cached = null;
  const closers = [...lazyQueueClosers];
  lazyQueueClosers.clear();
  for (const close of closers) await close();
  await closeDbHandle();
}
