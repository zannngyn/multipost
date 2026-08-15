import { randomBytes, randomUUID } from "node:crypto";

import { makeSystemClock } from "@/adapters/clock/system-clock";
import { makeMediaSigner } from "@/adapters/crypto/media-signer";
import { DrizzleCatalogConfigRepo } from "@/adapters/db/catalog-config-repo.drizzle";
import { DrizzleChannelConfigRepo } from "@/adapters/db/channel-config-repo.drizzle";
import { DrizzleChannelGroupRepo } from "@/adapters/db/channel-group-repo.drizzle";
import { closeDbHandle, getDbHandle, type Database } from "@/adapters/db/client";
import { DrizzleMediaRepo } from "@/adapters/db/media-repo.drizzle";
import { makeSecretBox, type SecretBox } from "@/adapters/db/secret-box";
import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import { DrizzleProductRepo } from "@/adapters/db/product-repo.drizzle";
import { DrizzleSyncRunRepo } from "@/adapters/db/sync-run-repo.drizzle";
import { DrizzleTenantRepo } from "@/adapters/db/tenant-repo.drizzle";
import { DrizzleUserRepo } from "@/adapters/db/user-repo.drizzle";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { makeDriveVideoProbe } from "@/adapters/media/drive-video-probe";
import { makeFfprobeMediaProbe } from "@/adapters/media/ffprobe-probe";
import { makeFacebookOAuthClient } from "@/adapters/meta/facebook-oauth";
import { makeFacebookPublisher } from "@/adapters/meta/facebook-publisher";
import { makeGraphClient } from "@/adapters/meta/graph-client";
import { makeTikTokClient } from "@/adapters/tiktok/tiktok-client";
import { makeTikTokPublisher } from "@/adapters/tiktok/tiktok-publisher";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { AppError } from "@/core/domain/errors";
import {
  signMediaUrl,
  type SignatureFn,
  type SignedMediaUrl,
} from "@/core/domain/media-url";
import type { DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type {
  ChannelConnectClient,
  ChannelPlatform,
  ChannelPublisher,
} from "@/core/ports/publisher";
import type { SheetSource } from "@/core/ports/sheet-source";
import { makeComposePost, type ComposePost } from "@/core/usecases/compose-post";
import {
  makeConnectFacebookChannels,
  type ConnectFacebookChannels,
} from "@/core/usecases/connect-facebook-channels";
import { makeManageChannels, type ManageChannels } from "@/core/usecases/manage-channels";
import { makeCreatePostBatch, type CreatePostBatch } from "@/core/usecases/create-post-batch";
import { makeGetBatchStatus, type GetBatchStatus } from "@/core/usecases/get-batch-status";
import { makeGetMediaContent, type GetMediaContent } from "@/core/usecases/get-media-content";
import { makeListPostJobs, type ListPostJobs } from "@/core/usecases/list-post-jobs";
import {
  makeManageChannelGroups,
  type ManageChannelGroups,
} from "@/core/usecases/manage-channel-groups";
import type { ManagePromptTemplates } from "@/core/usecases/manage-prompt-templates";
import { makeReapPostJobs, type ReapPostJobs } from "@/core/usecases/reap-post-jobs";
import { makeRetryPostJob, type RetryPostJob } from "@/core/usecases/retry-post-job";
import {
  makeCancelScheduledJob,
  type CancelScheduledJob,
} from "@/core/usecases/cancel-scheduled-job";
import {
  makeListScheduledJobs,
  type ListScheduledJobs,
} from "@/core/usecases/list-scheduled-jobs";
import {
  makeReschedulePostJob,
  type ReschedulePostJob,
} from "@/core/usecases/reschedule-post-job";
import { makeGetCatalogSource, type GetCatalogSource } from "@/core/usecases/get-catalog-source";
import {
  makeListCatalogProducts,
  type ListCatalogProducts,
} from "@/core/usecases/list-catalog-products";
import {
  makeUpdateCatalogSource,
  type UpdateCatalogSource,
} from "@/core/usecases/update-catalog-source";
import { makeGetSyncStatus, type GetSyncStatus } from "@/core/usecases/get-sync-status";
import { makeHealthcheckTenant, type HealthcheckTenant } from "@/core/usecases/healthcheck-tenant";
import { makePublishPost, type PublishPost } from "@/core/usecases/publish-post";
import { makeSyncCatalog, type SyncCatalog } from "@/core/usecases/sync-catalog";

import {
  closeAiStores,
  makeLazyGenerateCaptions,
  makeLazyPromptTemplates,
  type GenerateCaptions,
} from "./ai-engine";
import {
  loadConfig,
  loadMediaConfig,
  loadMetaConfig,
  loadMetaOAuthConfig,
  loadSecretsConfig,
  loadVideoConfig,
  type Config,
  type EnvRecord,
} from "./config";
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
  /** E2 — "nguồn dữ liệu" panel: which Drive folder / Sheet this tenant reads. */
  getCatalogSource: GetCatalogSource;
  /** E2 — point the tenant at another folder/sheet. Does NOT trigger a sync. */
  updateCatalogSource: UpdateCatalogSource;
  /** E2/E3 — catalog screen: products with their composable/blocked verdict. */
  listCatalogProducts: ListCatalogProducts;
  composePost: ComposePost;
  generateCaptions: GenerateCaptions;
  /** E10.7 — versioned prompt catalog (list/create/activate). */
  promptTemplates: ManagePromptTemplates;
  /** E7.2 — fan a post out to N channels (called by the web API). */
  createPostBatch: CreatePostBatch;
  /** E7.4 — publish one job on one channel (called by the worker). */
  publishPost: PublishPost;
  /** E7.5 — per-channel results + batch summary. */
  getBatchStatus: GetBatchStatus;
  /** E11.1 — operator job log. */
  listPostJobs: ListPostJobs;
  /** E11.1 — re-queue a failed/blocked job (stock recheck still applies). */
  retryPostJob: RetryPostJob;
  /** E7.6 — preset channel groups (list/create/update/delete). */
  channelGroups: ManageChannelGroups;
  /** E5.1 — the channel list itself (read / switch on-off / remove). */
  channels: ManageChannels;
  /** E5.1 — connect Fanpages: OAuth, or by pasting a User Access Token. */
  connectChannels: ConnectFacebookChannels;
  /** E8.4 — "bài đã hẹn": what publishes next, soonest first. */
  listScheduledJobs: ListScheduledJobs;
  /** E8.4 — move a scheduled post to another time. */
  reschedulePostJob: ReschedulePostJob;
  /** E8.4 — cancel a scheduled post before it goes out. */
  cancelScheduledJob: CancelScheduledJob;
  /** Periodic sweep for jobs stuck in `publishing` / overdue with no queue entry. */
  reapPostJobs: ReapPostJobs;
  /** E3.6 — serve one media asset to Meta's fetcher (called by /api/media). */
  getMediaContent: GetMediaContent;
  /**
   * E3.6 — mint the public URL Graph API will fetch. Synchronous on purpose:
   * whoever builds a post batch needs one URL per photo, not a round trip.
   */
  signMediaUrl: SignMediaUrl;
}

export interface SignMediaUrlRequest {
  readonly tenantId: string;
  /** Drive file id, i.e. `MediaAsset.driveFileId` / `PostJobMedia.driveFileId`. */
  readonly assetId: string;
  /** Public origin Meta will call, e.g. `https://mysp.example.com`. */
  readonly baseUrl: string;
  /** Defaults to 6h; clamped to [1min, 24h]. */
  readonly ttlMs?: number;
}

export type SignMediaUrl = (input: SignMediaUrlRequest) => SignedMediaUrl;

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
  /** E6 — override per platform; the key wins over `publisher` for that platform. */
  publishers?: Partial<Record<ChannelPlatform, ChannelPublisher>>;
  /** E3 Phase 2 — tests/scripts inject a probe instead of spawning ffprobe. */
  videoProbe?: VideoAssetProbe;
  /** E5.1 — tests/scripts connect channels without a Meta app. */
  channelConnect?: ChannelConnectClient;
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
    remove: (jobId) => build().remove(jobId),
    has: (jobId) => build().has(jobId),
    enqueueRepeatable: (input) => build().enqueueRepeatable(input),
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
  return {
    publishImagePost: (input) => build().publishImagePost(input),
    publishVideoPost: (input) => build().publishVideoPost(input),
  };
}

/**
 * TikTok publisher (E6), built on first use like every other outbound adapter:
 * a process that never posts to TikTok must not need its transport.
 * Live posting additionally needs the app audit + domain verification
 * (PENDING(tiktok-live-verify) / PENDING(tiktok-domain-verify) in the adapter).
 */
function makeLazyTikTokPublisher(logger: Logger): ChannelPublisher {
  let real: ChannelPublisher | null = null;
  const build = (): ChannelPublisher => {
    real ??= makeTikTokPublisher({ client: makeTikTokClient({ logger }), logger });
    return real;
  };
  return {
    publishImagePost: (input) => build().publishImagePost(input),
    publishVideoPost: (input) => build().publishVideoPost(input),
  };
}

/**
 * Facebook CONNECT client (E5.1), built on first use — the same contract as the
 * publisher: a process that never connects a Page reads no Meta app credential.
 *
 * The credentials are optional here (see MetaOAuthConfigSchema): pasting a User
 * Access Token needs none, and the OAuth door refuses with a message naming the
 * missing variables. So a missing META_APP_SECRET must NOT stop this from being
 * built — it only changes what the adapter can do.
 */
function makeLazyFacebookConnect(logger: Logger): ChannelConnectClient {
  let real: ChannelConnectClient | null = null;
  const build = (): ChannelConnectClient => {
    if (!real) {
      const oauth = loadMetaOAuthConfig();
      real = makeFacebookOAuthClient({
        logger,
        appId: oauth.META_APP_ID ?? null,
        appSecret: oauth.META_APP_SECRET ?? null,
        redirectUri: oauth.META_OAUTH_REDIRECT_URI ?? null,
        version: loadMetaConfig().META_GRAPH_VERSION,
      });
    }
    return real;
  };
  return {
    buildAuthorizeUrl: (input) => build().buildAuthorizeUrl(input),
    exchangeCodeForUserToken: (input) => build().exchangeCodeForUserToken(input),
    extendUserToken: (input) => build().extendUserToken(input),
    listAccounts: (input) => build().listAccounts(input),
  };
}

/**
 * Video spec probe (E3 Phase 2), built on first use like every other outward
 * adapter: FFPROBE_PATH is read at the first probe, not at boot, and a process
 * that never composes a video post never touches the binary.
 *
 * A missing binary is NOT fatal here: the error is logged ONCE with the path we
 * tried (repeating it per photo-less compose would drown the log) and rethrown
 * so composePost can turn it into "chưa kiểm — worker sẽ kiểm" rather than a
 * block. The worker image carries ffmpeg/ffprobe, and that is where the check
 * becomes binding (docs/02 section 5.4).
 */
function makeLazyVideoProbe(drive: DriveSource, logger: Logger): VideoAssetProbe {
  let real: VideoAssetProbe | null = null;
  let warnedMissing = false;

  const build = (): VideoAssetProbe => {
    if (!real) {
      const config = loadVideoConfig();
      real = makeDriveVideoProbe({
        drive,
        probe: makeFfprobeMediaProbe({
          logger,
          ffprobePath: config.FFPROBE_PATH,
          timeoutMs: config.VIDEO_PROBE_TIMEOUT_MS,
        }),
        logger,
      });
    }
    return real;
  };

  return {
    probeAsset: async (input) => {
      try {
        return await build().probeAsset(input);
      } catch (error) {
        if (AppError.is(error) && error.context.reason === "FFPROBE_NOT_AVAILABLE") {
          if (!warnedMissing) {
            warnedMissing = true;
            logger.warn("ffprobe is not installed in this process — video specs stay unchecked", {
              ...error.toLogObject(),
              hint: "FFPROBE_PATH",
            });
          }
        }
        throw error;
      }
    },
  };
}

/**
 * AES-256-GCM box for credentials kept in `tenant_integration.config`.
 * Exported so every repo touching that blob seals/opens with the SAME key and
 * envelope (see adapters/db/secret-box for the contract). The key is read on
 * first use, not at build: a process that never reads a credential must boot
 * without TENANT_SECRETS_ENC_KEY.
 */
export function makeTenantSecretBox(logger: Logger, env?: EnvRecord): SecretBox {
  return makeSecretBox({
    logger,
    readKey: () => loadSecretsConfig(env).TENANT_SECRETS_ENC_KEY,
  });
}

/** HMAC for signed media URLs; MEDIA_SIGNING_SECRET is read on first signature. */
function makeLazyMediaSigner(env?: EnvRecord): SignatureFn {
  return makeMediaSigner({ readSecret: () => loadMediaConfig(env).MEDIA_SIGNING_SECRET });
}

export function makeUsecases(deps: Infra, overrides: UsecaseOverrides = {}): Usecases {
  const tenants = new DrizzleTenantRepo(deps.db);
  const products = new DrizzleProductRepo(deps.db);
  const media = new DrizzleMediaRepo(deps.db);
  const syncRuns = new DrizzleSyncRunRepo(deps.db);
  const catalogConfig = new DrizzleCatalogConfigRepo(deps.db, deps.logger);
  const postJobs = new DrizzlePostJobRepo(deps.db);
  const channels = new DrizzleChannelConfigRepo(deps.db, {
    box: makeTenantSecretBox(deps.logger),
    logger: deps.logger,
  });
  const channelGroups = new DrizzleChannelGroupRepo(deps.db);
  // E11.1/E8.4 audit: session e-mail -> app_user.id for every operator action.
  const users = new DrizzleUserRepo(deps.db);
  const google = makeLazyGoogleSources({ logger: deps.logger });
  const queue = overrides.queue ?? makeLazyJobQueue(deps.config, deps.logger);
  const publisher = overrides.publisher ?? makeLazyPublisher(deps.logger);
  // One publisher per platform: the channel decides which API a job goes to.
  const publishers: Partial<Record<ChannelPlatform, ChannelPublisher>> = {
    facebook: overrides.publishers?.facebook ?? publisher,
    tiktok: overrides.publishers?.tiktok ?? makeLazyTikTokPublisher(deps.logger),
  };
  const drive = overrides.drive ?? google.drive;
  const mediaSign = makeLazyMediaSigner();
  /**
   * Read on FIRST USE, not here: a web/worker process must boot without
   * MEDIA_PUBLIC_BASE_URL, and the failure must land on the operator creating a
   * post (with the variable name), not on a container that refuses to start.
   */
  const mediaBaseUrl = (): string => loadMediaConfig().MEDIA_PUBLIC_BASE_URL;
  const signMediaUrlFn: SignMediaUrl = (input: SignMediaUrlRequest): SignedMediaUrl =>
    signMediaUrl({
      tenantId: input?.tenantId,
      assetId: input?.assetId,
      baseUrl: input?.baseUrl,
      ttlMs: input?.ttlMs,
      nowMs: deps.clock.nowMs(),
      sign: mediaSign,
    });

  return {
    healthcheckTenant: makeHealthcheckTenant({
      tenants,
      clock: deps.clock,
      logger: deps.logger,
    }),
    syncCatalog: makeSyncCatalog({
      drive,
      sheet: overrides.sheet ?? google.sheet,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock: deps.clock,
      logger: deps.logger,
    }),
    getSyncStatus: makeGetSyncStatus({ syncRuns, logger: deps.logger }),
    getCatalogSource: makeGetCatalogSource({ catalogConfig, logger: deps.logger }),
    updateCatalogSource: makeUpdateCatalogSource({
      catalogConfig,
      logger: deps.logger,
      users,
    }),
    listCatalogProducts: makeListCatalogProducts({ catalog: products, logger: deps.logger }),
    composePost: makeComposePost({
      products,
      media,
      logger: deps.logger,
      videoProbe: overrides.videoProbe ?? makeLazyVideoProbe(drive, deps.logger),
    }),
    generateCaptions: makeLazyGenerateCaptions({
      logger: deps.logger,
      clock: deps.clock,
      db: deps.db,
      redisUrl: deps.config.REDIS_URL,
    }),
    promptTemplates: makeLazyPromptTemplates({
      logger: deps.logger,
      clock: deps.clock,
      db: deps.db,
    }),
    createPostBatch: makeCreatePostBatch({
      postJobs,
      products,
      channels,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      newId: () => randomUUID(),
      signMediaUrl: signMediaUrlFn,
      mediaBaseUrl,
    }),
    publishPost: makePublishPost({
      postJobs,
      products,
      channels,
      publishers,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      // Re-signed per attempt: a queued job can outlive the URL it was born with.
      signMediaUrl: signMediaUrlFn,
      mediaBaseUrl,
      // Same lazy probe composePost uses (E3): built on first use, so a process
      // without ffprobe boots fine and only warns when a video is published.
      videoProbe: overrides.videoProbe ?? makeLazyVideoProbe(drive, deps.logger),
      mediaAssets: media,
    }),
    getBatchStatus: makeGetBatchStatus({ postJobs, logger: deps.logger }),
    listPostJobs: makeListPostJobs({ postJobs, logger: deps.logger }),
    retryPostJob: makeRetryPostJob({
      postJobs,
      channels,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      users,
    }),
    listScheduledJobs: makeListScheduledJobs({
      postJobs,
      clock: deps.clock,
      logger: deps.logger,
    }),
    reschedulePostJob: makeReschedulePostJob({
      postJobs,
      channels,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      users,
    }),
    cancelScheduledJob: makeCancelScheduledJob({
      postJobs,
      queue,
      logger: deps.logger,
      users,
    }),
    reapPostJobs: makeReapPostJobs({
      postJobs,
      queue,
      channels,
      clock: deps.clock,
      logger: deps.logger,
    }),
    channelGroups: makeManageChannelGroups({
      groups: channelGroups,
      channels,
      logger: deps.logger,
      newId: () => randomUUID(),
    }),
    channels: makeManageChannels({ channels, logger: deps.logger, users }),
    connectChannels: makeConnectFacebookChannels({
      channels,
      connect: overrides.channelConnect ?? makeLazyFacebookConnect(deps.logger),
      logger: deps.logger,
      // 32 random bytes, hex: the CSRF nonce of the OAuth round trip. Core has
      // no crypto of its own (docs/07 §2), so it is injected here.
      newState: () => randomBytes(32).toString("hex"),
      users,
    }),
    getMediaContent: makeGetMediaContent({
      drive,
      mediaAssets: media,
      sign: mediaSign,
      clock: deps.clock,
      logger: deps.logger,
    }),
    signMediaUrl: signMediaUrlFn,
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
 * Route-contract constants of the public media endpoint, re-exported so the
 * app layer (allowed to import composition, not core/domain) shares one source
 * of truth with the signer.
 */
export { MEDIA_QUERY_PARAMS, MEDIA_ROUTE_PREFIX } from "@/core/domain/media-url";

/**
 * Drains the DB pool, any lazily built producer queue and the AI registry cache
 * connection. For scripts and graceful shutdown, not per request. (The worker's
 * own queue/connection is owned and closed by worker-container.)
 */
export async function closeContainer(): Promise<void> {
  cached = null;
  const closers = [...lazyQueueClosers];
  lazyQueueClosers.clear();
  for (const close of closers) await close();
  await closeAiStores();
  await closeDbHandle();
}
