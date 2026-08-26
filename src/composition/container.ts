import { createHash, randomBytes, randomUUID } from "node:crypto";

import { makeScryptPasswordHasher } from "@/adapters/auth/scrypt-password-hasher";
import { makeSystemClock } from "@/adapters/clock/system-clock";
import { makeMediaSigner } from "@/adapters/crypto/media-signer";
import type { TenantId } from "@/core/domain/tenant-context";
import { DrizzleAccessRequestRepo } from "@/adapters/db/access-request-repo.drizzle";
import { DrizzleAccountRepo } from "@/adapters/db/account-repo.drizzle";
import { DrizzleInviteRepo } from "@/adapters/db/invite-repo.drizzle";
import { DrizzleMemberRepo } from "@/adapters/db/member-repo.drizzle";
import { DrizzleAppearanceSettingRepo } from "@/adapters/db/appearance-setting-repo.drizzle";
import { DrizzlePlatformTenantRepo } from "@/adapters/db/platform-tenant-repo.drizzle";
import { DrizzleSupportSessionRepo } from "@/adapters/db/support-session-repo.drizzle";
import { DrizzleOAuthStateStore } from "@/adapters/db/oauth-state-store.drizzle";
import { DrizzleTenantOnboardingRepo } from "@/adapters/db/tenant-onboarding-repo.drizzle";
import { DrizzleTenantProfileRepo } from "@/adapters/db/tenant-profile-repo.drizzle";
import { DrizzleCatalogConfigRepo } from "@/adapters/db/catalog-config-repo.drizzle";
import { DrizzleChannelConfigRepo } from "@/adapters/db/channel-config-repo.drizzle";
import { DrizzleChannelGroupRepo } from "@/adapters/db/channel-group-repo.drizzle";
import { DrizzleCredentialRepo } from "@/adapters/db/credential-repo.drizzle";
import { closeDbHandle, getDbHandle, type Database } from "@/adapters/db/client";
import { DrizzleGoogleOAuthRepo } from "@/adapters/db/google-oauth-repo.drizzle";
import { DrizzleMediaRepo } from "@/adapters/db/media-repo.drizzle";
import { makeSecretBox, type SecretBox } from "@/adapters/db/secret-box";
import { DrizzlePostDraftRepo } from "@/adapters/db/post-draft-repo.drizzle";
import { DrizzlePostJobRepo } from "@/adapters/db/post-job-repo.drizzle";
import { DrizzleProductRepo } from "@/adapters/db/product-repo.drizzle";
import { DrizzleSyncRunRepo } from "@/adapters/db/sync-run-repo.drizzle";
import { DrizzleTenantRepo } from "@/adapters/db/tenant-repo.drizzle";
import { DrizzleUserRepo } from "@/adapters/db/user-repo.drizzle";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { makeDriveVideoProbe } from "@/adapters/media/drive-video-probe";
import { makeLocalBlobStore } from "@/adapters/media/local-blob-store";
import { makeCsvCatalogTextSource } from "@/adapters/catalog/csv-text-source";
import { makeSheetCatalogTextSource } from "@/adapters/catalog/sheet-text-source";
import { makeLocalCatalogFileStore } from "@/adapters/catalog/local-catalog-file-store";
import { makeLocalMediaCache } from "@/adapters/media/local-media-cache";
import { makeFfprobeMediaProbe } from "@/adapters/media/ffprobe-probe";
import { makeFacebookOAuthClient } from "@/adapters/meta/facebook-oauth";
import { makeFacebookPublisher } from "@/adapters/meta/facebook-publisher";
import { makeGraphClient } from "@/adapters/meta/graph-client";
import { makeTikTokClient } from "@/adapters/tiktok/tiktok-client";
import { makeTikTokPublisher } from "@/adapters/tiktok/tiktok-publisher";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { makeRedisJobProgressStore } from "@/adapters/queue/redis-job-progress";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { AppError } from "@/core/domain/errors";
import {
  signMediaUrl,
  type SignatureFn,
  type SignedMediaUrl,
} from "@/core/domain/media-url";
import type { DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobProgressStore } from "@/core/ports/job-progress";
import type { JobQueue, QueueWorkerRegistry } from "@/core/ports/job-queue";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaByteCache } from "@/core/ports/media-byte-cache";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type {
  ChannelConnectClient,
  ChannelPlatform,
  ChannelPublisher,
  ScheduledPublisher,
} from "@/core/ports/publisher";
import type { SheetSource } from "@/core/ports/sheet-source";
import { makeBrowseGoogleDrive, type BrowseGoogleDrive } from "@/core/usecases/browse-google-drive";
import {
  makeCheckOperatorAccess,
  type CheckOperatorAccess,
} from "@/core/usecases/check-operator-access";
import { makeCreateTenant, type CreateTenant } from "@/core/usecases/create-tenant";
import {
  makeEnsureDefaultTenant,
  type EnsureDefaultTenant,
} from "@/core/usecases/ensure-default-tenant";
import {
  makeGetOperatorOverview,
  type GetOperatorOverview,
} from "@/core/usecases/get-operator-overview";
import {
  makeJoinWithInvite,
  type JoinWithInvite,
} from "@/core/usecases/join-with-invite";
import { makeManageInvites, type ManageInvites } from "@/core/usecases/manage-invites";
import { makeManageMembers, type ManageMembers } from "@/core/usecases/manage-members";
import { makePlatformAppearance } from "@/core/usecases/platform-appearance";
import { makePlatformTenants, type PlatformTenants } from "@/core/usecases/platform-tenants";
import {
  makeManageSupportSessions,
  type ManageSupportSessions,
} from "@/core/usecases/manage-support-sessions";
import { makePasswordAuth, type PasswordAuth } from "@/core/usecases/password-auth";
import {
  makeResolveOperatorAccount,
} from "@/core/usecases/resolve-operator-account";
import {
  makeManageAccessRequests,
  type AccessDecisionResult,
  type DecideAccessRequestInput,
  type ListAccessRequestsInput,
  type ManageAccessRequests,
} from "@/core/usecases/manage-access-requests";
import { makeComposePost, type ComposePost } from "@/core/usecases/compose-post";
import {
  makeConnectFacebookChannels,
  type ConnectFacebookChannels,
} from "@/core/usecases/connect-facebook-channels";
import {
  makeConnectGoogleDrive,
  type ConnectGoogleDrive,
} from "@/core/usecases/connect-google-drive";
import { makeManageChannels, type ManageChannels } from "@/core/usecases/manage-channels";
import { makeCreatePostBatch, type CreatePostBatch } from "@/core/usecases/create-post-batch";
import { makeGetBatchStatus, type GetBatchStatus } from "@/core/usecases/get-batch-status";
import { makeGetMediaContent, type GetMediaContent } from "@/core/usecases/get-media-content";
import { makeGetMediaPreview, type GetMediaPreview } from "@/core/usecases/get-media-preview";
import { makeListPostJobs, type ListPostJobs } from "@/core/usecases/list-post-jobs";
import {
  makeManageChannelGroups,
  type ManageChannelGroups,
} from "@/core/usecases/manage-channel-groups";
import type { ManagePromptTemplates } from "@/core/usecases/manage-prompt-templates";
import { makeReapPostJobs, type ReapPostJobs } from "@/core/usecases/reap-post-jobs";
import {
  makeReconcileScheduledPosts,
  type ReconcileScheduledPosts,
} from "@/core/usecases/reconcile-scheduled-posts";
import { makeRetryPostJob, type RetryPostJob } from "@/core/usecases/retry-post-job";
import { makeCleanupUploads, type CleanupUploads } from "@/core/usecases/cleanup-uploads";
import {
  makeCleanupMediaCache,
  type CleanupMediaCache,
} from "@/core/usecases/cleanup-media-cache";
import { makeReadMediaBytes, type ReadMediaBytes } from "@/core/usecases/read-media-bytes";
import { makeUploadMedia, type UploadMedia } from "@/core/usecases/upload-media";
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
import { makeGetSetupProgress, type GetSetupProgress } from "@/core/usecases/get-setup-progress";
import {
  makeCompleteOnboarding,
  makeGetOnboardingProfile,
  makeSaveOnboardingProfile,
  type CompleteOnboarding,
  type GetOnboardingProfile,
  type SaveOnboardingProfile,
} from "@/core/usecases/onboarding-profile";
import {
  makeProfileCatalogSource,
  type ProfileCatalogSource,
} from "@/core/usecases/profile-catalog-source";
import {
  makeUploadCatalogFile,
  type UploadCatalogFile,
} from "@/core/usecases/upload-catalog-file";
import {
  makeListCatalogProducts,
  type ListCatalogProducts,
} from "@/core/usecases/list-catalog-products";
import {
  makeUpdateCatalogSource,
  type UpdateCatalogSource,
} from "@/core/usecases/update-catalog-source";
import { makeGetSyncStatus, type GetSyncStatus } from "@/core/usecases/get-sync-status";
import { makeGetWorkerHealth, type GetWorkerHealth } from "@/core/usecases/get-worker-health";
import { makeSavePostDraft, type SavePostDraft } from "@/core/usecases/save-post-draft";
import { makeLoadPostDraft, type LoadPostDraft } from "@/core/usecases/load-post-draft";
import { makeDiscardPostDraft, type DiscardPostDraft } from "@/core/usecases/discard-post-draft";
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
  loadMediaCacheConfig,
  loadCatalogFileConfig,
  loadUploadConfig,
  loadMetaConfig,
  loadMetaOAuthConfig,
  loadOnboardingConfig,
  loadSecretsConfig,
  loadVideoConfig,
  type Config,
  type EnvRecord,
} from "./config";
import { makeLazyGoogleSources } from "./google-sources";
import { makeOperatorAccessGate, type OperatorAccessGate } from "./operator-access-gate";
import { makeOAuthStateService, type OAuthStateService } from "./oauth-state-service";
import {
  makeLazyAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limiter";
import { makeOperatorAccountGate, type OperatorAccountGate } from "./operator-account-gate";
import { makeAppearanceGate, type AppearanceGate } from "./appearance-gate";
import { makeRequirePlatformAdmin, type RequirePlatformAdmin } from "./require-platform-admin";
import { makeRequireTenant, type RequireTenant } from "./require-tenant";

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
  /**
   * E2 — onboarding: dry-run a tenant's Sheet/Drive and report how much of it
   * this tool can actually use, BEFORE anything is configured.
   */
  profileCatalogSource: ProfileCatalogSource;
  /**
   * E2/phase 3 — the tenant hands us a CSV instead of connecting a Sheet. Reads
   * it BEFORE storing the bytes, so an unreadable file is refused while the
   * operator is still looking at the screen.
   */
  uploadCatalogFile: UploadCatalogFile;
  /** E2 — point the tenant at another folder/sheet. Does NOT trigger a sync. */
  updateCatalogSource: UpdateCatalogSource;
  /**
   * First-run — the six setup flags behind the checklist and the dock, read in
   * ONE request so the dock can ride in the shell without costing five.
   */
  getSetupProgress: GetSetupProgress;
  /**
   * E10 — the onboarding survey (spec §8). Three verbs on one row: read it so a
   * half-finished flow reopens where it stopped, save ONE step at a time, and
   * stamp `completed_at` once — that stamp is what stops the flow reappearing.
   */
  getOnboardingProfile: GetOnboardingProfile;
  saveOnboardingProfile: SaveOnboardingProfile;
  completeOnboarding: CompleteOnboarding;
  /** E2/E3 — catalog screen: products with their composable/blocked verdict. */
  listCatalogProducts: ListCatalogProducts;
  composePost: ComposePost;
  /** E9 — mode B: register operator-supplied files as media assets. */
  uploadMedia: UploadMedia;
  /** E9.4 — periodic sweep of uploads nobody posted. */
  cleanupUploads: CleanupUploads;
  /** E3.6 — periodic sweep of the Drive byte cache (TTL-based). */
  cleanupMediaCache: CleanupMediaCache;
  generateCaptions: GenerateCaptions;
  /** E10.7 — versioned prompt catalog (list/create/activate). */
  promptTemplates: ManagePromptTemplates;
  /** E7.2 — fan a post out to N channels (called by the web API). */
  createPostBatch: CreatePostBatch;
  /** E7.4 — publish one job on one channel (called by the worker). */
  publishPost: PublishPost;
  /** E7.5 — per-channel results + batch summary. */
  getBatchStatus: GetBatchStatus;
  /** E10 — autosave the compose screen so a refresh does not lose typed work. */
  savePostDraft: SavePostDraft;
  /** E10 — read the draft back on mount (input only; compose re-runs for real). */
  loadPostDraft: LoadPostDraft;
  /** E10 — drop the draft after a batch is created, or on "Xoá nháp". */
  discardPostDraft: DiscardPostDraft;
  /**
   * E10 — `account.id` -> `app_user.id`, the owner every draft is addressed by.
   * Exposed because the draft route (unlike retry/reschedule, which hand an
   * e-mail to a usecase that resolves it internally) needs the id BEFORE it can
   * call anything: a draft with no owner is tenant-shared, and two operators
   * would overwrite each other.
   *
   * Keyed on the ACCOUNT, not the session e-mail (was `findOperatorUserId`):
   * docs/09 §3.1 makes the address an attribute of an identity, so keying
   * ownership on it means an operator who changes e-mail loses their drafts,
   * and two identities of one person get two buckets. `requireTenant` has
   * already authorised (account, tenant) before this is called.
   *
   * `null` for an account with no `app_user` row is NOT an error — the route
   * answers "chỉ lưu trên máy này" and the screen says so.
   */
  findDraftOwnerUserId: (tenantId: TenantId, accountId: string) => Promise<string | null>;
  /**
   * E1.4 — "ai được vào công cụ này", read on EVERY request (short-cached).
   * `getOperatorSession` calls this: the session is a stateless JWT, so a block
   * only bites if the status is re-read per request.
   */
  operatorAccess: OperatorAccessGate;
  /** E1.4 — the approval screen: list who is waiting, approve with a role, block. */
  accessRequests: ManageAccessRequests;
  /**
   * M1.2 — identity → account → membership, the session's source of truth
   * (short-cached; a suspension is felt within ACCOUNT_CACHE_TTL_MS).
   */
  operatorAccounts: OperatorAccountGate;
  /**
   * E-mail + password sign-up / sign-in / admin reset. The DECISION only —
   * Auth.js still mints the session and `decideSignIn` still has the last word
   * through the account tables, exactly as for Google and Facebook.
   */
  passwordAuth: PasswordAuth;
  /**
   * The sliding window in front of the two password doors (per IP, per
   * address). Exposed on the container rather than hidden inside the usecase
   * because the KEY is an interface-layer fact: only the server action can see
   * the caller's IP.
   */
  authRateLimit: AuthRateLimiter;
  /** M1.2 — `GET /api/me`: account + companies + active tenant. */
  getOperatorOverview: GetOperatorOverview;
  /**
   * M1.3b — server-side OAuth state (doc 10 §6): the connect routes issue a
   * nonce bound to (tenant, account); the callbacks claim it single-use.
   * (`selectActiveTenant` retired here: /api/me/active-tenant now authorises
   * through `requireTenant` directly — same fresh check, one code path.)
   */
  oauthStates: OAuthStateService;
  /** M2.1 — self-service company creation; the creator becomes owner. */
  createTenant: CreateTenant;
  /**
   * E10 — first entry without a company provisions one (spec §1). Idempotent:
   * an account that already belongs somewhere gets that company back.
   */
  ensureDefaultTenant: EnsureDefaultTenant;
  /** M2.2 — invite links: list / create (role ladder) / revoke. */
  invites: ManageInvites;
  /** M2.2 — `POST /api/join`: token → membership (NoMembership state's door). */
  joinWithInvite: JoinWithInvite;
  /** M2.3 — members screen: list / change role (ladder) / remove. */
  members: ManageMembers;
  /**
   * M3.1 — the platform authoriser: `account.platform_role`, read FRESH per
   * call (every platform op is tier S). No tenant context involved.
   */
  requirePlatformAdmin: RequirePlatformAdmin;
  /** M3.2 — platform tenant administration: list / provision / (un)suspend. */
  platformTenants: PlatformTenants;
  /**
   * M3.4 — the colour of the product, one value for every company. Exposed as
   * the GATE, not the bare usecase: the root layout reads it on the way to
   * every page, so the cache is not optional and must not be bypassable.
   */
  platformAppearance: AppearanceGate;
  /** M3.3 — support mode: audited visits into customer tenants, read-only. */
  supportSessions: ManageSupportSessions;
  /**
   * M1.2 — THE tenant authoriser (docs/09 §3.3). Routes adopt it in M1.3;
   * until then only /api/me* and tests touch it.
   */
  requireTenant: RequireTenant;
  /** E11.1 — operator job log. */
  listPostJobs: ListPostJobs;
  /** E11.1 — re-queue a failed/blocked job (stock recheck still applies). */
  retryPostJob: RetryPostJob;
  /**
   * E11 — "có worker nào đang chạy không?" for the /jobs banner. Advisory only:
   * never throws, and no publish path may branch on it.
   */
  getWorkerHealth: GetWorkerHealth;
  /** E7.6 — preset channel groups (list/create/update/delete). */
  channelGroups: ManageChannelGroups;
  /** E5.1 — the channel list itself (read / switch on-off / remove). */
  channels: ManageChannels;
  /** E5.1 — connect Fanpages: OAuth, or by pasting a User Access Token. */
  connectChannels: ConnectFacebookChannels;
  /** E2 — connect the tenant's own Google account (OAuth) for Drive/Sheets. */
  connectGoogleDrive: ConnectGoogleDrive;
  /** E2 — browse that account's folders/spreadsheets from inside the app. */
  browseGoogleDrive: BrowseGoogleDrive;
  /** E8.4 — "bài đã hẹn": what publishes next, soonest first. */
  listScheduledJobs: ListScheduledJobs;
  /** E8.4 — move a scheduled post to another time. */
  reschedulePostJob: ReschedulePostJob;
  /** E8.4 — cancel a scheduled post before it goes out. */
  cancelScheduledJob: CancelScheduledJob;
  /** Periodic sweep for jobs stuck in `publishing` / overdue with no queue entry. */
  reapPostJobs: ReapPostJobs;
  /** E8.6 — periodic sweep asking Facebook whether it published a handed-over post. */
  reconcileScheduledPosts: ReconcileScheduledPosts;
  /** E3.6 — serve one media asset to Meta's fetcher (called by /api/media). */
  getMediaContent: GetMediaContent;
  /**
   * E3.6b — serve one IMAGE to a signed-in operator (called by
   * /api/media/preview). Session + membership decide, not a signed URL: a
   * bearer token must not travel in an `<img src>` (doc 10 §2).
   */
  getMediaPreview: GetMediaPreview;
  /**
   * E3.6 — mint the public URL Graph API will fetch. Synchronous on purpose:
   * whoever builds a post batch needs one URL per photo, not a round trip.
   */
  signMediaUrl: SignMediaUrl;
}

export interface SignMediaUrlRequest {
  readonly tenantId: TenantId;
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
  /** E9 — swap the upload store (tests use a temp dir, prod a Docker volume). */
  blobs?: MediaBlobStore;
  /** E3.6 — swap the Drive byte cache (a smoke script may want it disabled). */
  mediaCache?: MediaByteCache;
  sheet?: SheetSource;
  /** Worker passes its own queue so one process holds ONE Redis connection. */
  queue?: JobQueue;
  /**
   * E7.5 — same reason as `queue`: the worker builds the progress store on the
   * Redis connection it already has, and tests pass an in-memory one.
   */
  progress?: JobProgressStore;
  publisher?: ChannelPublisher;
  /** E6 — override per platform; the key wins over `publisher` for that platform. */
  publishers?: Partial<Record<ChannelPlatform, ChannelPublisher>>;
  /** E3 Phase 2 — tests/scripts inject a probe instead of spawning ffprobe. */
  videoProbe?: VideoAssetProbe;
  /** E5.1 — tests/scripts connect channels without a Meta app. */
  channelConnect?: ChannelConnectClient;
  /**
   * E5 — the photo bytes the publisher uploads. Overridden by the smoke script,
   * whose media ids are fixtures that exist in neither Drive nor the snapshot.
   */
  readMediaBytes?: ReadMediaBytes;
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
function makeLazyJobQueue(config: Config, logger: Logger): JobQueue & QueueWorkerRegistry {
  let real: (JobQueue & QueueWorkerRegistry) | null = null;
  let closer: (() => Promise<void>) | null = null;

  const build = (): JobQueue & QueueWorkerRegistry => {
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
    // Building the queue here is what OPENS the Redis connection, so a health
    // probe on a dead broker fails inside the adapter — which answers
    // `reachable: false` instead of throwing (see QueueWorkerRegistry).
    countWorkers: async () => {
      try {
        return await build().countWorkers();
      } catch (error) {
        // Only reachable when the connection itself cannot be constructed
        // (missing/blank REDIS_URL): still an answer, never an exception.
        logger.warn("could not open a queue connection to count workers", {
          err: AppError.from(error, "QUEUE_ERROR", { operation: "queue.countWorkers" }),
          error_code: "QUEUE_ERROR",
        });
        return { workersOnline: 0, reachable: false };
      }
    },
    close: async () => {
      if (closer) await closer();
      real = null;
      closer = null;
    },
  };
}

/** Closers of lazily built queues, drained by closeContainer(). */
const lazyQueueClosers = new Set<() => Promise<void>>();

/** Does this queue also answer "how many workers are attached?" (E11 banner)? */
function isWorkerRegistry(queue: JobQueue): queue is JobQueue & QueueWorkerRegistry {
  return typeof (queue as Partial<QueueWorkerRegistry>).countWorkers === "function";
}

/**
 * E7.5 — live job progress (design §5.3), built on first use like the queue
 * above: a page render and `next build` must not need a reachable Redis.
 *
 * In practice this connection stays unopened in the WORKER: that process passes
 * its own store, built on the connection it already holds for BullMQ (see
 * worker-container). The web process opens it only when the tracking screen
 * actually asks for progress.
 */
function makeLazyJobProgressStore(config: Config, logger: Logger): JobProgressStore {
  let real: JobProgressStore | null = null;

  const build = (): JobProgressStore => {
    if (real) return real;
    /**
     * The offline queue stays ON (the ioredis default), and the adapter's
     * command timeout is what bounds a dead Redis — see
     * PROGRESS_COMMAND_TIMEOUT_MS.
     *
     * Turning it off was tried and reverted: a command issued before the
     * connection finished opening is rejected outright ("Stream isn't
     * writeable"), so the FIRST poll after a cold start lost its progress
     * against a perfectly healthy Redis. Waiting a few milliseconds for a
     * connection that is coming up is correct; only waiting forever is not, and
     * that is the timeout's job.
     */
    const connection = createRedisConnection({ url: config.REDIS_URL, logger });
    real = makeRedisJobProgressStore({ connection, logger });
    lazyQueueClosers.add(async () => {
      real = null;
      await connection.quit();
    });
    return real;
  };

  return {
    report: (input) => build().report(input),
    read: (tenantId, postJobIds) => build().read(tenantId, postJobIds),
    clear: (tenantId, postJobId) => build().clear(tenantId, postJobId),
  };
}

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
    // E8.6 — Facebook holds scheduled posts itself. Delegating instead of
    // exposing the built object keeps the adapter lazy: reading `.scheduled`
    // does not build a Graph client, calling one of its methods does.
    scheduled: {
      schedulePost: (input) => scheduledOf(build()).schedulePost(input),
      getPostState: (input) => scheduledOf(build()).getPostState(input),
      deleteScheduledPost: (input) => scheduledOf(build()).deleteScheduledPost(input),
    },
  };
}

/** The scheduled half of a publisher that must have one (the Facebook adapter). */
function scheduledOf(publisher: ChannelPublisher): ScheduledPublisher {
  if (!publisher.scheduled) {
    throw new AppError("INTERNAL", {
      message: "This publisher has no scheduled half wired",
      userMessage: "Kênh này chưa hỗ trợ hẹn giờ đăng — vui lòng báo quản trị viên.",
      context: { reason: "SCHEDULER_NOT_WIRED" },
    });
  }
  return publisher.scheduled;
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

/**
 * Drive byte cache (E3.6). TTL is configured in hours; the store thinks in ms.
 *
 * Returns the hours ALONGSIDE the store because the sweep needs the very same
 * number: two readings of the config are two chances to drift, and a sweep on a
 * different TTL either deletes entries the store still serves or keeps files
 * long past what was configured. One parse, one number, both callers.
 */
function makeMediaCache(
  logger: Logger,
  env?: EnvRecord,
): { cache: MediaByteCache; ttlHours: number } {
  const config = loadMediaCacheConfig(env);
  return {
    cache: makeLocalMediaCache({
      root: config.MEDIA_CACHE_ROOT,
      ttlMs: config.MEDIA_CACHE_TTL_HOURS * 60 * 60 * 1000,
      logger,
    }),
    ttlHours: config.MEDIA_CACHE_TTL_HOURS,
  };
}

/** HMAC for signed media URLs; MEDIA_SIGNING_SECRET is read on first signature. */
function makeLazyMediaSigner(env?: EnvRecord): SignatureFn {
  return makeMediaSigner({ readSecret: () => loadMediaConfig(env).MEDIA_SIGNING_SECRET });
}

export function makeUsecases(deps: Infra, overrides: UsecaseOverrides = {}): Usecases {
  const tenants = new DrizzleTenantRepo(deps.db);
  const products = new DrizzleProductRepo(deps.db);
  const media = new DrizzleMediaRepo(deps.db);
  const syncRuns = new DrizzleSyncRunRepo(deps.db, deps.logger);
  const catalogConfig = new DrizzleCatalogConfigRepo(deps.db, deps.logger);
  const postJobs = new DrizzlePostJobRepo(deps.db);
  const channels = new DrizzleChannelConfigRepo(deps.db, {
    box: makeTenantSecretBox(deps.logger),
    logger: deps.logger,
  });
  const channelGroups = new DrizzleChannelGroupRepo(deps.db);
  // E10 — one open compose draft per operator per tenant.
  const postDrafts = new DrizzlePostDraftRepo(deps.db);
  // E10 — the onboarding survey answers; one row per tenant.
  const tenantProfiles = new DrizzleTenantProfileRepo(deps.db);
  // E11.1/E8.4 audit: session e-mail -> app_user.id for every operator action.
  const users = new DrizzleUserRepo(deps.db);
  // E1.4 — who may sign in. Read on every request through `operatorAccess`.
  const accessRequestRepo = new DrizzleAccessRequestRepo(deps.db, { logger: deps.logger });
  // E2 — the tenant's own Google connection. Same secret box as the Meta
  // tokens: the refresh token is sealed inside tenant_integration.config.
  const googleOAuth = new DrizzleGoogleOAuthRepo(deps.db, {
    box: makeTenantSecretBox(deps.logger),
    logger: deps.logger,
  });
  const google = makeLazyGoogleSources({ logger: deps.logger, oauth: googleOAuth });
  const lazyQueue = makeLazyJobQueue(deps.config, deps.logger);
  const queue = overrides.queue ?? lazyQueue;
  const jobProgress = overrides.progress ?? makeLazyJobProgressStore(deps.config, deps.logger);
  // The worker census is a SEPARATE port (nothing that publishes gets it). An
  // override may be a plain JobQueue — the worker's own queue does implement the
  // census, a test fake does not — so fall back to the real lazy queue, which
  // opens its connection only if someone actually asks for a count.
  const workerRegistry: QueueWorkerRegistry = isWorkerRegistry(queue) ? queue : lazyQueue;
  const publisher = overrides.publisher ?? makeLazyPublisher(deps.logger);
  // One publisher per platform: the channel decides which API a job goes to.
  const publishers: Partial<Record<ChannelPlatform, ChannelPublisher>> = {
    facebook: overrides.publishers?.facebook ?? publisher,
    tiktok: overrides.publishers?.tiktok ?? makeLazyTikTokPublisher(deps.logger),
  };
  const drive = overrides.drive ?? google.drive;
  // E9 — mode B bytes. Cheap to build (a path, no connection), so unlike the
  // Google sources it needs no lazy wrapper.
  const blobs = overrides.blobs ?? makeLocalBlobStore({ root: loadUploadConfig().UPLOAD_STORAGE_ROOT });

  // Phase 3 — a tenant may hand us a CSV instead of connecting a Google Sheet.
  // Its own root, never the upload root: these bytes ARE the product catalog,
  // so the orphan sweep that owns UPLOAD_STORAGE_ROOT must not reach them.
  const catalogFiles = makeLocalCatalogFileStore({
    root: loadCatalogFileConfig().CATALOG_STORAGE_ROOT,
  });
  // Order is not a priority list — the run picks by the tenant's own
  // `textSource` ref via canRead(); both are always offered.
  const csvCatalogSource = makeCsvCatalogTextSource({ logger: deps.logger });
  const catalogSources = [
    csvCatalogSource,
    makeSheetCatalogTextSource({ sheet: overrides.sheet ?? google.sheet, logger: deps.logger }),
  ];
  // E3.6 — read-through cache in front of Drive. Cheap to build (a path and a
  // TTL, no connection), so like the blob store it needs no lazy wrapper; both
  // of its variables have working defaults, so no deployment must set them.
  // The sweep below reuses `mediaCacheTtlHours` from this ONE parse. A test that
  // overrides the store keeps these hours: the port exposes no TTL to read back,
  // and a wrong number in a test is louder than a silently divergent sweep.
  const builtMediaCache = makeMediaCache(deps.logger);
  const mediaCache = overrides.mediaCache ?? builtMediaCache.cache;
  const mediaCacheTtlHours = builtMediaCache.ttlHours;
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

  const checkOperatorAccess: CheckOperatorAccess = makeCheckOperatorAccess({
    requests: accessRequestRepo,
    clock: deps.clock,
    logger: deps.logger,
  });
  const operatorAccess = makeOperatorAccessGate({
    access: checkOperatorAccess,
    clock: deps.clock,
    logger: deps.logger,
  });
  const manageAccessRequests = makeManageAccessRequests({
    requests: accessRequestRepo,
    clock: deps.clock,
    logger: deps.logger,
    users,
  });
  // M1.2 — global identity (docs/09 §3.1): the session and the tenant
  // authoriser both read these tables, each behind its own short cache.
  const accountRepo = new DrizzleAccountRepo(deps.db, { logger: deps.logger });
  const resolveOperatorAccount = makeResolveOperatorAccount({
    accounts: accountRepo,
    logger: deps.logger,
  });
  const operatorAccounts = makeOperatorAccountGate({
    resolveAccount: resolveOperatorAccount,
    // M3.1 — the one-time env→DB promotion (race-safe in the repo).
    grantBootstrapPlatformRole: (accountId, sessionEmail) =>
      accountRepo.grantBootstrapPlatformRole(accountId, sessionEmail),
    clock: deps.clock,
    logger: deps.logger,
  });
  /**
   * Password sign-in. The hasher is stateless and cheap to build (the cost is
   * paid per call, in `scrypt`), so unlike Redis/Google it needs no lazy seam.
   */
  const authRateLimit = makeLazyAuthRateLimiter({
    redisUrl: deps.config.REDIS_URL,
    clock: deps.clock,
    logger: deps.logger,
  });
  // Registered with the SAME set the lazy queue/progress connections use, so
  // `closeContainer()` drains it without knowing whether it was ever opened.
  lazyQueueClosers.add(() => authRateLimit.close());
  const passwordAuth = makePasswordAuth({
    credentials: new DrizzleCredentialRepo(deps.db, { logger: deps.logger }),
    accounts: accountRepo,
    hasher: makeScryptPasswordHasher(),
    clock: deps.clock,
    logger: deps.logger,
  });
  const supportSessionRepo = new DrizzleSupportSessionRepo(deps.db, { logger: deps.logger });
  const tenantGate = makeRequireTenant({
    accounts: accountRepo,
    // M3.3 — fresh liveness read; the session row IS the authorisation.
    findSupportSession: (sessionId, accountId) =>
      supportSessionRepo.findLive(sessionId, accountId, deps.clock.now()),
    clock: deps.clock,
    logger: deps.logger,
  });
  // M2.1/M2.2 — onboarding. Token hashing mirrors the oauth-state service:
  // core owns no crypto, the port only ever sees hashes.
  const hashInviteToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");
  const onboardingLimits = () => {
    const cfg = loadOnboardingConfig();
    return {
      maxCreatedTotal: cfg.TENANT_CREATE_MAX_PER_ACCOUNT,
      maxCreatedPerHour: cfg.TENANT_CREATE_MAX_PER_HOUR,
    };
  };
  const baseCreateTenant = makeCreateTenant({
    onboarding: new DrizzleTenantOnboardingRepo(deps.db, { logger: deps.logger }),
    clock: deps.clock,
    logger: deps.logger,
    // Read per call, not at boot: the web process must start without these vars.
    get limits() {
      return onboardingLimits();
    },
    randomSuffix: () => randomBytes(2).toString("hex"),
  });
  /**
   * Creating a company mints a NEW membership — every cache over accounts and
   * memberships is stale the same instant, so they drop HERE (the same
   * discipline as decideAccessRequest below). Without this, /api/me and
   * requireTenant would not see the new company for up to a TTL.
   *
   * Named rather than inlined into `usecases.createTenant` because
   * `ensureDefaultTenant` delegates to the SAME wrapper: a company it
   * provisions must invalidate exactly as much.
   */
  const createTenant: CreateTenant = async (input) => {
    const result = await baseCreateTenant(input);
    operatorAccounts.invalidateAll();
    tenantGate.invalidateAll();
    return result;
  };
  const inviteRepo = new DrizzleInviteRepo(deps.db, { logger: deps.logger });
  const baseJoinWithInvite = makeJoinWithInvite({
    invites: inviteRepo,
    clock: deps.clock,
    logger: deps.logger,
    hashToken: hashInviteToken,
  });
  const baseMembers = makeManageMembers({
    members: new DrizzleMemberRepo(deps.db, { logger: deps.logger }),
    logger: deps.logger,
  });
  const basePlatformTenants = makePlatformTenants({
    platformTenants: new DrizzlePlatformTenantRepo(deps.db, { logger: deps.logger }),
    invites: inviteRepo,
    clock: deps.clock,
    logger: deps.logger,
    newToken: () => randomBytes(32).toString("hex"),
    hashToken: hashInviteToken,
    randomSuffix: () => randomBytes(2).toString("hex"),
  });
  /**
   * M3.4 — the appearance setting, behind its own short cache (see
   * `appearance-gate.ts`): the root layout asks for it on the way to EVERY
   * page, so an uncached read would be a query per page view.
   */
  const platformAppearance = makeAppearanceGate({
    appearance: makePlatformAppearance({
      settings: new DrizzleAppearanceSettingRepo(deps.db, { logger: deps.logger }),
      logger: deps.logger,
    }),
    clock: deps.clock,
    logger: deps.logger,
  });
  /**
   * The cache is dropped the instant a decision is written — wired HERE rather
   * than inside the usecase so core stays free of caching, and so nobody can
   * call `decide` through a path that forgets it. Without this the operator we
   * just blocked would keep working for up to ACCESS_CACHE_TTL_MS.
   */
  const accessRequests: ManageAccessRequests = {
    listAccessRequests: (input: ListAccessRequestsInput) =>
      manageAccessRequests.listAccessRequests(input),
    decideAccessRequest: async (
      input: DecideAccessRequestInput,
    ): Promise<AccessDecisionResult> => {
      const result = await manageAccessRequests.decideAccessRequest(input);
      operatorAccess.invalidateAll();
      // The decision also wrote account/membership rows (M1.2) — every cache
      // over them is stale the same instant.
      operatorAccounts.invalidateAll();
      tenantGate.invalidateAll();
      return result;
    },
  };

  return {
    healthcheckTenant: makeHealthcheckTenant({
      tenants,
      clock: deps.clock,
      logger: deps.logger,
    }),
    syncCatalog: makeSyncCatalog({
      drive,
      sheet: overrides.sheet ?? google.sheet,
      catalogSources,
      catalogFiles,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock: deps.clock,
      logger: deps.logger,
    }),
    getSyncStatus: makeGetSyncStatus({ syncRuns, logger: deps.logger }),
    getCatalogSource: makeGetCatalogSource({ catalogConfig, logger: deps.logger }),
    profileCatalogSource: makeProfileCatalogSource({
      sheet: overrides.sheet ?? google.sheet,
      drive,
      // Without these the compatibility report cannot read an uploaded file, so
      // a CSV tenant would see a report describing a source they do not use.
      catalogSources,
      catalogFiles,
      logger: deps.logger,
    }),
    uploadCatalogFile: makeUploadCatalogFile({
      // The SAME reader the later sync uses — a file that previews here and
      // fails at sync time would be the worst possible outcome.
      catalogSource: csvCatalogSource,
      catalogFiles,
      catalogConfig,
      users,
      clock: deps.clock,
      logger: deps.logger,
    }),
    updateCatalogSource: makeUpdateCatalogSource({
      catalogConfig,
      logger: deps.logger,
      users,
      // Pointing the tenant at another folder/sheet invalidates the stored
      // "can this account read it?" verdict — recompute it right away.
      oauth: googleOAuth,
      browser: google.browser,
      clock: deps.clock,
    }),
    getSetupProgress: makeGetSetupProgress({
      google: googleOAuth,
      catalogConfig,
      channels,
      groups: channelGroups,
      postJobs,
      logger: deps.logger,
    }),
    getOnboardingProfile: makeGetOnboardingProfile({ profiles: tenantProfiles, logger: deps.logger }),
    saveOnboardingProfile: makeSaveOnboardingProfile({ profiles: tenantProfiles, logger: deps.logger }),
    completeOnboarding: makeCompleteOnboarding({
      profiles: tenantProfiles,
      // Injected, not `new Date()`: `completed_at` is the one value that decides
      // whether the flow ever appears again, so a test must be able to pin it.
      clock: deps.clock,
      logger: deps.logger,
    }),
    listCatalogProducts: makeListCatalogProducts({
      catalog: products,
      // Without this the stock verdict always runs in `numeric` mode, so a
      // tenant on a textual/disabled policy would read a stock badge that does
      // not match the gate their posts actually go through.
      catalogConfig,
      logger: deps.logger,
    }),
    composePost: makeComposePost({
      products,
      media,
      catalogConfig,
      logger: deps.logger,
      videoProbe: overrides.videoProbe ?? makeLazyVideoProbe(drive, deps.logger),
    }),
    uploadMedia: makeUploadMedia({
      blobs,
      media,
      logger: deps.logger,
      // Prefixed so an id is recognisable as mode B in a log line, and hex-only
      // so it is a safe path segment for the blob store.
      newAssetId: () => `upload_${randomUUID().replace(/-/g, "")}`,
    }),
    cleanupUploads: makeCleanupUploads({
      media,
      blobs,
      clock: deps.clock,
      logger: deps.logger,
    }),
    cleanupMediaCache: makeCleanupMediaCache({
      cache: mediaCache,
      // The SAME hours the adapter serves by — same parse, not a second read.
      ttlHours: mediaCacheTtlHours,
      clock: deps.clock,
      logger: deps.logger,
    }),
    generateCaptions: makeLazyGenerateCaptions({
      logger: deps.logger,
      clock: deps.clock,
      db: deps.db,
      redisUrl: deps.config.REDIS_URL,
      // Claim validation compares a caption against the labels of THIS tenant's
      // sheet; without it an external tenant is judged by MYSP's column names.
      catalogConfig,
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
      // Same stock policy the compose screen used; without it a tenant whose
      // sheet spells stock in words has every code rejected as NaN.
      catalogConfig,
      // Bug B6 — turns the session e-mail into the `app_user.id` stored in
      // `post_batch.created_by`; without it every batch is unattributed.
      users,
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
      // Runs in the worker: the second stock check (business rule 3) must read
      // the SAME policy the compose step did, or a post clears the gate at
      // compose time and dies here.
      catalogConfig,
      // Doc 10 §5.2 — a suspended tenant must not publish, and the worker has
      // no session to check it for us.
      tenants,
      queue,
      // E7.5 — where each step of this publish is reported (design §5.6).
      progress: jobProgress,
      clock: deps.clock,
      logger: deps.logger,
      // Re-signed per attempt: a queued job can outlive the URL it was born with.
      signMediaUrl: signMediaUrlFn,
      mediaBaseUrl,
      // Same lazy probe composePost uses (E3): built on first use, so a process
      // without ffprobe boots fine and only warns when a video is published.
      videoProbe: overrides.videoProbe ?? makeLazyVideoProbe(drive, deps.logger),
      mediaAssets: media,
      // E5 — the photo path UPLOADS bytes (multipart `source`) instead of
      // handing Graph a URL to fetch, so it needs a way to read one file at a
      // time: cache first, then Drive / the blob store. Same store and same
      // lookup the media route serves from; nothing here re-reads the config.
      readMediaBytes:
        overrides.readMediaBytes ??
        makeReadMediaBytes({
          cache: mediaCache,
          drive,
          blobs,
          mediaAssets: media,
          logger: deps.logger,
        }),
    }),
    // E7.5 — the same store publishPost writes to; here it is only READ, and a
    // store that is down costs the stepper, not the table (design §5.7).
    getBatchStatus: makeGetBatchStatus({ postJobs, progress: jobProgress, logger: deps.logger }),
    savePostDraft: makeSavePostDraft({ drafts: postDrafts, logger: deps.logger }),
    loadPostDraft: makeLoadPostDraft({ drafts: postDrafts, logger: deps.logger }),
    discardPostDraft: makeDiscardPostDraft({ drafts: postDrafts, logger: deps.logger }),
    findDraftOwnerUserId: (tenantId: TenantId, accountId: string) =>
      users.findUserIdByAccount(tenantId, accountId),
    operatorAccess,
    accessRequests,
    operatorAccounts,
    passwordAuth,
    authRateLimit,
    getOperatorOverview: makeGetOperatorOverview({ accounts: accountRepo, logger: deps.logger }),
    oauthStates: makeOAuthStateService({
      store: new DrizzleOAuthStateStore(deps.db, { logger: deps.logger }),
      clock: deps.clock,
    }),
    createTenant,
    /**
     * E10 — lazy provisioning on first entry. It reads memberships through the
     * RAW repo, not `operatorAccounts`: a cached "no memberships" would
     * provision a second company for someone who already has one.
     */
    ensureDefaultTenant: makeEnsureDefaultTenant({
      accounts: accountRepo,
      createTenant,
      logger: deps.logger,
    }),
    invites: makeManageInvites({
      invites: inviteRepo,
      clock: deps.clock,
      logger: deps.logger,
      newToken: () => randomBytes(32).toString("hex"),
      hashToken: hashInviteToken,
    }),
    joinWithInvite: async (input) => {
      const result = await baseJoinWithInvite(input);
      if (!result.alreadyMember) {
        operatorAccounts.invalidateAll();
        tenantGate.invalidateAll();
      }
      return result;
    },
    /**
     * M2.3 — writes change memberships: every cache over them dies with the
     * decision (same discipline as decide/join above). The version bump covers
     * OTHER processes; this covers this one, instantly.
     */
    members: {
      listMembers: (input) => baseMembers.listMembers(input),
      changeRole: async (input) => {
        const result = await baseMembers.changeRole(input);
        operatorAccounts.invalidateAll();
        tenantGate.invalidateAll();
        return result;
      },
      removeMember: async (input) => {
        const result = await baseMembers.removeMember(input);
        operatorAccounts.invalidateAll();
        tenantGate.invalidateAll();
        return result;
      },
    },
    requirePlatformAdmin: makeRequirePlatformAdmin({
      accounts: accountRepo,
      logger: deps.logger,
    }),
    /**
     * M3.2 — a status flip changes what EVERY member of that tenant may do:
     * the caches over memberships/accounts die with the decision (tier S sees
     * the fresh row regardless; this closes the R/M window in this process).
     */
    platformTenants: {
      listTenants: () => basePlatformTenants.listTenants(),
      createTenant: (input) => basePlatformTenants.createTenant(input),
      setTenantStatus: async (input) => {
        const result = await basePlatformTenants.setTenantStatus(input);
        operatorAccounts.invalidateAll();
        tenantGate.invalidateAll();
        return result;
      },
    },
    platformAppearance,
    supportSessions: makeManageSupportSessions({
      sessions: supportSessionRepo,
      clock: deps.clock,
      logger: deps.logger,
    }),
    requireTenant: tenantGate.requireTenant,
    listPostJobs: makeListPostJobs({ postJobs, logger: deps.logger }),
    retryPostJob: makeRetryPostJob({
      postJobs,
      channels,
      queue,
      clock: deps.clock,
      logger: deps.logger,
      users,
    }),
    getWorkerHealth: makeGetWorkerHealth({
      workers: workerRegistry,
      postJobs,
      clock: deps.clock,
      logger: deps.logger,
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
      // E8.6 — a cancel must be able to DELETE the post Facebook is holding;
      // without these two it can only refuse, and a refused cancel is a post
      // that publishes anyway.
      channels,
      publishers,
    }),
    reapPostJobs: makeReapPostJobs({
      postJobs,
      queue,
      channels,
      clock: deps.clock,
      logger: deps.logger,
    }),
    reconcileScheduledPosts: makeReconcileScheduledPosts({
      postJobs,
      channels,
      publishers,
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
    connectGoogleDrive: makeConnectGoogleDrive({
      oauth: googleOAuth,
      client: google.oauthClient,
      // Same object that resolves the per-tenant Drive/Sheet identity: a
      // connect/disconnect must drop the client the next sync would reuse.
      authCache: google.auth,
      // Right after a connect, check whether the account that just arrived can
      // read the source this tenant already had.
      catalogConfig,
      browser: google.browser,
      clock: deps.clock,
      logger: deps.logger,
      newState: () => randomBytes(32).toString("hex"),
      users,
    }),
    browseGoogleDrive: makeBrowseGoogleDrive({
      browser: google.browser,
      oauth: googleOAuth,
      logger: deps.logger,
    }),
    getMediaContent: makeGetMediaContent({
      drive,
      blobs,
      cache: mediaCache,
      mediaAssets: media,
      sign: mediaSign,
      clock: deps.clock,
      logger: deps.logger,
    }),
    // Same sources, same cache — only the door differs (no `sign`, no `clock`:
    // there is no signature to verify and no expiry to compare against).
    getMediaPreview: makeGetMediaPreview({
      drive,
      blobs,
      cache: mediaCache,
      mediaAssets: media,
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
 * E9 upload caps, re-exported for the same reason: the intake route must know
 * them to refuse a file before buffering it, and a second copy of the numbers
 * in the route would give one business rule two homes.
 */
export { MAX_UPLOADS_PER_POST, MAX_UPLOAD_BYTES } from "@/core/domain/uploaded-media";
export type { UploadedFile } from "@/core/usecases/upload-media";

/**
 * E5.2 — sign-in with Facebook asks for the same Page scopes the channel import
 * needs, so the two must never drift apart. Re-exported rather than retyped in
 * `app/_auth`: a second list is a second thing to forget when a scope changes.
 */
export { FACEBOOK_CONNECT_SCOPES } from "@/adapters/meta/facebook-oauth";

/**
 * The seeded tenant. Re-exported for the sign-in flow, which has no user ->
 * tenant mapping yet (PENDING: multi-tenant sign-in is a product decision).
 */
export { DEMO_TENANT_ID } from "@/adapters/db/seed-constants";

/**
 * E1.4 — which tenant a brand-new sign-in identity is filed under.
 *
 * PENDING(tenant-mapping): a first sign-in cannot say which tenant the person
 * belongs to, and this deployment has exactly one (the same assumption the
 * Facebook channel import already makes). When multi-tenant sign-in lands, this
 * becomes a lookup, not a constant — every caller already passes it explicitly.
 */
export { DEMO_TENANT_ID as ACCESS_REGISTRY_TENANT_ID } from "@/adapters/db/seed-constants";

/**
 * Access-registry vocabulary the thin routes need for their zod schemas. The
 * app layer may not import `core/usecases` (docs/07 §2), and a second copy of
 * these literals in a route would be a second thing to update.
 */
export { ACCESS_DECISIONS } from "@/core/usecases/manage-access-requests";
export type {
  AccessDecision,
  AccessDecisionResult,
  AccessRequestView,
} from "@/core/usecases/manage-access-requests";
export type { OperatorAccessState } from "@/core/usecases/check-operator-access";

/**
 * M1.2 vocabulary the app layer needs (it may not import core/usecases or
 * core/domain/* except errors — docs/07 §2): session shape, overview DTO and
 * the tenant-context types the routes will consume from M1.3.
 */
export type {
  OperatorAccountState as OperatorAccountSessionState,
} from "@/core/usecases/resolve-operator-account";
export type { OperatorOverview } from "@/core/usecases/get-operator-overview";

/**
 * Password sign-in vocabulary for the app layer (which may not import
 * `core/usecases` or `core/ports` — docs/07 §2): what `authorize` hands Auth.js,
 * and the two budgets the server action spends before it hashes anything.
 */
export type { PasswordIdentity } from "@/core/usecases/password-auth";
export { AUTH_EMAIL_RULE, AUTH_IP_RULE } from "./auth-rate-limiter";
export type { PlatformRole } from "@/core/domain/account";
export type { TenantContext, TenantId } from "@/core/domain/tenant-context";

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
