/**
 * Publishing ports (E5/E7). Core declares WHAT it needs from a social platform;
 * adapters/meta knows HOW (Graph API). Pure TypeScript: no imports outside
 * core (docs/07 §2) — the word "Graph" must not appear below.
 *
 * TikTok (Phase 2) implements the same ChannelPublisher; nothing in core changes.
 */

import type { ChannelGroup } from "@/core/domain/channel-group";
import type { SignedMediaUrl } from "@/core/domain/media-url";

/**
 * Mints the public, time-limited URL a platform fetches for one media asset
 * (E3.6). Declared as a port because the MAC lives in adapters/crypto: core
 * builds posts, it never touches a signing secret.
 *
 * Still used by create-post-batch (the stored job keeps a link for the preview
 * screen) and by the VIDEO path, which hands the platform a URL. The Facebook
 * PHOTO path no longer uses it: it uploads the bytes itself (see
 * PublishMediaItem).
 */
export type SignMediaUrlFn = (input: {
  readonly tenantId: string;
  /** Drive file id = `PostJobMedia.driveFileId`. */
  readonly assetId: string;
  /** Public origin Meta will call, e.g. `https://mysp.example.com`. */
  readonly baseUrl: string;
  readonly ttlMs?: number;
}) => SignedMediaUrl;

export const CHANNEL_PLATFORMS = ["facebook", "tiktok"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export const CHANNEL_STATUSES = ["active", "disabled"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/**
 * One publishing target of a tenant, read from `tenant_integration`
 * (business rule 7: never hardcoded, never in env).
 *
 * `accessToken` is a SECRET: never log it, never put it in an AppError context,
 * never return it from an API route. `redactToken()` below exists so a log line
 * can still say WHICH token was used.
 */
export interface ChannelConfig {
  /** Stable id used by post_job.channel_id, e.g. "fbpage-shop-a". */
  readonly channelId: string;
  readonly platform: ChannelPlatform;
  readonly name: string;
  /** Facebook Page id (the platform-side account id). */
  readonly externalId: string;
  readonly accessToken: string;
  readonly status: ChannelStatus;
  /** ISO date the token expires, when the platform tells us. */
  readonly tokenExpiresAt: Date | null;
  /**
   * TikTok-only settings (E6). Kept in its own block instead of widening the
   * shared shape: a Facebook channel has no privacy level, and an optional
   * field on the common type would let one platform's config leak into the
   * other's code path unnoticed.
   */
  readonly tiktok?: TikTokChannelOptions;
}

/**
 * TikTok Content Posting settings that live per channel.
 * `privacyLevel` MUST be one of the values `creator_info` reports for that
 * account: TikTok rejects anything else with privacy_level_option_mismatch.
 */
export interface TikTokChannelOptions {
  readonly privacyLevel: string;
  /**
   * Declares AI-generated content. Default TRUE for this product: the captions
   * are written by an LLM, and TikTok requires the disclosure.
   */
  readonly isAigc: boolean;
  /** Creator open id, when the connect flow stored it. */
  readonly openId: string | null;
  readonly disableDuet?: boolean;
  readonly disableStitch?: boolean;
  readonly disableComment?: boolean;
}

/** Never log a raw token; this keeps the log useful without leaking it. */
export function redactToken(token: string | null | undefined): string {
  if (typeof token !== "string" || token.length === 0) return "(none)";
  return `***${token.slice(-4)} (len=${token.length})`;
}

/**
 * Per-tenant publishing knobs (brief §6: "khoảng cách chỉnh được").
 * PENDING(E1): `spacingMs` is applied BETWEEN POSTS OF THE SAME CHANNEL — two
 * channels publish in parallel, because the rate limit that matters is per Page.
 */
export interface PublishSettings {
  /** Minimum gap between two posts on one channel. Default 60_000 (brief: 1–3'). */
  readonly spacingMs: number;
  /** Base backoff between publish retries. Default 60_000. */
  readonly retryBackoffMs: number;
  /** Total publish attempts including the first. Default 3 (= 2 retries). */
  readonly maxAttempts: number;
}

export const DEFAULT_PUBLISH_SETTINGS: PublishSettings = {
  spacingMs: 60_000,
  retryBackoffMs: 60_000,
  maxAttempts: 3,
};

/**
 * One channel as the connect flow found it on the platform (E5.1).
 * `accessToken` is a SECRET: the repo seals it before it reaches the database,
 * and no layer above ever logs it.
 */
export interface ChannelUpsert {
  readonly channelId: string;
  readonly platform: ChannelPlatform;
  readonly name: string;
  readonly externalId: string;
  readonly accessToken: string;
  /** Null when the platform gives no expiry (a Page token from a long-lived user token). */
  readonly tokenExpiresAt: Date | null;
}

export interface UpsertChannelsInput {
  readonly tenantId: string;
  readonly channels: readonly ChannelUpsert[];
  /**
   * The USER token that listed these channels, kept (sealed) so "làm mới danh
   * sách" works without pasting it again. Omit to leave the stored one alone.
   */
  readonly userAccessToken?: string | null;
  readonly actorEmail?: string | null;
  readonly actorUserId?: string | null;
}

export interface UpsertChannelsResult {
  /** channelIds that did not exist before. */
  readonly added: readonly string[];
  /** channelIds whose name/token were refreshed. */
  readonly updated: readonly string[];
}

export interface SetChannelStatusInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly status: ChannelStatus;
  readonly actorEmail?: string | null;
  readonly actorUserId?: string | null;
}

export interface RemoveChannelInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly actorEmail?: string | null;
  readonly actorUserId?: string | null;
}

export interface ChannelConfigRepo {
  /** Null when the tenant has no such channel (-> CHANNEL_NOT_CONFIGURED). */
  findChannel(tenantId: string, channelId: string): Promise<ChannelConfig | null>;
  listChannels(tenantId: string): Promise<readonly ChannelConfig[]>;
  /** Falls back to DEFAULT_PUBLISH_SETTINGS when the tenant set nothing. */
  getPublishSettings(tenantId: string): Promise<PublishSettings>;

  /**
   * Writes what the connect flow found (E5.1). Contract for every implementer:
   * - one transaction, read-modify-write of the provider row + an audit row;
   * - a channel that already exists keeps its `status` (never re-enable a
   *   channel an operator switched off) and gets a fresh name/token;
   * - a channel that is new is stored ACTIVE (the operator picks channels per
   *   post, so a manual "bật" step would only be a dead click);
   * - a channel the tenant has but the platform did not list is left untouched
   *   — a partial listing must not delete channels;
   * - `accessToken`/`userAccessToken` are sealed before they are written, and
   *   never appear in a log, an AppError context or a return value;
   * - an empty `channels` list is AppError('INVALID_INPUT'), not a silent no-op.
   */
  upsertChannels(input: UpsertChannelsInput): Promise<UpsertChannelsResult>;

  /**
   * The stored USER token of the tenant, or null when nothing was ever saved.
   * Only the connect flow calls it; the value must never leave the server.
   */
  findUserAccessToken(tenantId: string): Promise<string | null>;

  /** Null when the tenant has no such channel (the caller reports "not found"). */
  setChannelStatus(input: SetChannelStatusInput): Promise<ChannelConfig | null>;

  /** False when nothing was removed — the caller reports "not found". */
  removeChannel(input: RemoveChannelInput): Promise<boolean>;
}

/** One account (Facebook Page) as the platform reports it during a connect. */
export interface RemoteChannelAccount {
  /** Platform-side account id (Facebook Page id). */
  readonly externalId: string;
  readonly name: string;
  readonly accessToken: string;
  readonly tokenExpiresAt: Date | null;
}

export interface ListRemoteChannelsResult {
  readonly accounts: readonly RemoteChannelAccount[];
  /** Accounts listed WITHOUT a usable token — ids only, so the log can name them. */
  readonly skipped: readonly string[];
}

export interface UserAccessToken {
  readonly userAccessToken: string;
  readonly expiresAt: Date | null;
  /**
   * False when the token was used as handed over (no app secret configured, so
   * no long-lived exchange). The caller warns: Page tokens then live as long as
   * the user token does.
   */
  readonly extended: boolean;
}

/**
 * The connect side of a platform (E5.1): the OAuth dance, and "which accounts
 * does this token manage". Separate from ChannelPublisher on purpose —
 * publishing happens in the worker, connecting happens in a browser round trip.
 *
 * Contract for every implementer:
 * - every platform response is parsed through a schema before it is trusted;
 * - paging is followed to the END (an account with 30 Pages must not lose 5);
 * - failures are AppError('TOKEN_EXPIRED'|'META_ERROR'|'CHANNEL_NOT_CONFIGURED')
 *   with a Vietnamese `userMessage` naming what the operator must do;
 * - tokens never enter a log or an AppError context.
 */
export interface ChannelConnectClient {
  /** Where the browser is sent to grant access. `state` is the CSRF nonce. */
  buildAuthorizeUrl(input: { readonly state: string }): string;
  /** OAuth `code` -> user token (long-lived when the app secret is configured). */
  exchangeCodeForUserToken(input: { readonly code: string }): Promise<UserAccessToken>;
  /** Extends a token the operator pasted; returns it unchanged without a secret. */
  extendUserToken(input: { readonly userAccessToken: string }): Promise<UserAccessToken>;
  listAccounts(input: { readonly userAccessToken: string }): Promise<ListRemoteChannelsResult>;
}

/**
 * Saved channel presets (E7.6). Separate from ChannelConfigRepo on purpose: the
 * channels themselves live in `tenant_integration` (hand-edited config, secrets
 * inside), the groups are plain operator data in their own table.
 *
 * Contract for every implementer:
 * - tenant-scoped; a bad tenant id throws AppError('INVALID_INPUT');
 * - a duplicate name for the same tenant throws AppError('INVALID_INPUT') with
 *   `context.reason = 'CHANNEL_GROUP_NAME_TAKEN'` (the unique index is the
 *   authority, not a pre-read);
 * - driver failures surface as AppError('DB_ERROR').
 */
export interface ChannelGroupRepo {
  listGroups(tenantId: string): Promise<readonly ChannelGroup[]>;
  findGroupById(tenantId: string, groupId: string): Promise<ChannelGroup | null>;
  createGroup(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
    readonly channelIds: readonly string[];
  }): Promise<ChannelGroup>;
  /** Null when the group does not exist for this tenant (never a silent insert). */
  updateGroup(input: {
    readonly tenantId: string;
    readonly groupId: string;
    readonly name: string;
    readonly channelIds: readonly string[];
  }): Promise<ChannelGroup | null>;
  /** False when nothing was deleted — the caller reports "not found". */
  deleteGroup(tenantId: string, groupId: string): Promise<boolean>;
}

/** Bytes of ONE media file plus the content type to declare for them. */
export interface PublishMediaBytes {
  readonly bytes: Uint8Array;
  /** Null when the source reported none; the adapter picks a safe default. */
  readonly mimeType: string | null;
}

/**
 * One photo of a post, as a LAZY byte source.
 *
 * Why bytes and not a URL: handing Graph a `url=` makes Facebook download the
 * file itself, and it abandons that download around 30s — measured on a real
 * 10-photo post, 4 of 10 made it. Uploading the bytes ourselves (multipart
 * `source`) put 10 of 10 on the same Page, because WE are the side that waits
 * and the worker may wait as long as it needs.
 *
 * Why `readBytes` is a FUNCTION and not the bytes: an album is up to 10 files of
 * ~9 MB, the worker runs several jobs at once, and a publisher uploads photo by
 * photo anyway. The bytes of photo k are read immediately before photo k is
 * uploaded and dropped afterwards, so one job holds one file, not ten.
 *
 * Contract for callers: `readBytes` may throw (asset gone, Drive down). It is a
 * failure of THIS post, never something to swallow — the publisher reports which
 * item failed and the usecase decides retry vs block.
 */
export interface PublishMediaItem {
  /** Asset identity (Drive file id, or `upload_<hex>` for mode B). */
  readonly driveFileId: string;
  readonly fileName: string;
  readonly readBytes: () => Promise<PublishMediaBytes>;
}

/**
 * E7.5 — what a publisher tells the caller WHILE it works (design §5.5).
 *
 * These are facts the adapter has in hand, never estimates: which photo of how
 * many, its file name, and the one moment that matters for business rule 4 —
 * the instant before the creating request leaves the process.
 */
export type PublishProgressEvent =
  | {
      readonly kind: "media_upload_started";
      /** 0-based index in album order. */
      readonly index: number;
      readonly total: number;
      readonly fileName: string;
    }
  | {
      readonly kind: "media_upload_finished";
      readonly index: number;
      readonly total: number;
      readonly fileName: string;
    }
  /** The request that creates the post is about to be sent. Exactly once. */
  | { readonly kind: "creating_post" }
  /** Byte-level video progress, for a platform that streams the file itself. */
  | {
      readonly kind: "video_upload_progress";
      readonly bytesSent: number;
      readonly bytesTotal: number | null;
    };

/**
 * Progress callback, shared by every publishing method below.
 *
 * Contract for every implementer:
 *  - called SYNCHRONOUSLY, fire-and-forget: never awaited, and its return value
 *    is ignored;
 *  - wrapped in try/catch by the adapter — a listener that throws is the
 *    listener's problem, never a failed post;
 *  - `creating_post` fires IMMEDIATELY BEFORE the creating request, exactly
 *    once, so the operator screen never says "sending" for a post that has not
 *    been sent (and business rule 4's boundary is visible on screen);
 *  - absent `onProgress` is normal: the adapter behaves exactly as before.
 */
export type PublishProgressListener = (event: PublishProgressEvent) => void;

export interface PublishImagePostInput {
  readonly tenantId: string;
  readonly channel: ChannelConfig;
  /** Final approved caption for THIS channel (brief §7.2: one per channel). */
  readonly caption: string;
  /** Ordered album, index 0 is the cover. 1..10 items. */
  readonly media: readonly PublishMediaItem[];
  /**
   * The anti-duplicate tuple, passed for logging/tracing only. The Graph API has
   * no idempotency header for photo posts: the real protection is the unique
   * index + the `queued -> publishing` claim (business rule 4).
   */
  readonly idempotencyKey: string;
  /** E7.5 — optional progress listener; see PublishProgressListener. */
  readonly onProgress?: PublishProgressListener;
}

export interface PublishResult {
  /** Platform post id — proof the post exists. */
  readonly postId: string;
  /** Permalink when the platform gives one; null otherwise. */
  readonly url: string | null;
}

/** Where a video goes: the normal feed, or the Reels surface. */
export const VIDEO_TARGETS = ["video", "reels"] as const;
export type VideoTarget = (typeof VIDEO_TARGETS)[number];

export interface PublishVideoPostInput {
  readonly tenantId: string;
  readonly channel: ChannelConfig;
  readonly caption: string;
  /**
   * ONE publicly fetchable video URL — the platform downloads it itself, the
   * same contract as photos. Videos are never uploaded byte-by-byte from here:
   * the worker holds no file, only a signed URL (E3.6).
   */
  readonly videoUrl: string;
  readonly target: VideoTarget;
  /**
   * Probed duration, when the caller already measured the clip (E5.3 gate).
   * TikTok needs it: `creator_info` reports a per-account maximum that no
   * static table can know, and exceeding it wastes the whole upload.
   */
  readonly durationSec?: number | null;
  /** Tracing only, like the image path. */
  readonly idempotencyKey: string;
  /** E7.5 — optional progress listener; see PublishProgressListener. */
  readonly onProgress?: PublishProgressListener;
}

/** Same post as `publishImagePost`, handed over for a LATER hour (E8.6). */
export interface SchedulePostInput extends PublishImagePostInput {
  /**
   * When the platform must publish it. The CALLER guarantees the lead time the
   * platform requires (core/domain/post-job: HANDOFF_* constants); the adapter
   * only forwards it and reports what the platform answered.
   */
  readonly publishAt: Date;
}

export interface SchedulePostResult {
  /**
   * Platform id of the post the platform now HOLDS, unpublished. It is not a
   * `publishedPostId`: nothing is live until the hour comes.
   */
  readonly scheduledPostId: string;
  /** Time the platform echoed back, when it reports one. */
  readonly publishAt: Date | null;
}

export interface RemotePostQuery {
  readonly tenantId: string;
  readonly channel: ChannelConfig;
  /** The id returned by `schedulePost`. */
  readonly postId: string;
}

/**
 * What the platform says about a post we handed over. `unknown` is a first-class
 * answer on purpose: claiming "published" without proof would put a wrong link
 * in front of an operator.
 *
 * There is deliberately NO "gone" state. "The platform will not show me this
 * object" is not proof that the object stopped existing: Graph answers a deleted
 * post, a token for the wrong Page and a lost permission with the SAME error
 * (code 100 / subcode 33). An implementer that cannot tell those apart MUST
 * report `unknown` with a reason, so no caller can turn a permission problem
 * into "Facebook sẽ không đăng nữa".
 */
export type RemotePostState =
  | {
      readonly state: "published";
      readonly postId: string;
      /** Real permalink from the platform — never a string we assembled. */
      readonly url: string | null;
      readonly publishedAt: Date | null;
    }
  | { readonly state: "scheduled"; readonly postId: string; readonly publishAt: Date | null }
  | { readonly state: "unknown"; readonly reason: string };

/**
 * THE contract every publishing method on this file obeys — `publishImagePost`,
 * `publishVideoPost` and `schedulePost` alike. It answers ONE question about a
 * failure, and it is the only question the caller can route on:
 *
 *     could this JOB have created a post on the platform?
 *
 * Every AppError thrown out of any of those three MUST carry EXACTLY ONE of
 * `context.platform_created_nothing = true` or `context.feed_dispatched = true`.
 * Neither flag (or both at once) is read as "a post may exist": the caller fails
 * closed, which costs a post that could have gone out — so say it, do not rely
 * on it.
 *
 * `context.platform_created_nothing = true` ONLY when the implementer knows that
 * NO REQUEST CAPABLE OF CREATING THE POST HAS EVER BEEN DISPATCHED for this job
 * — in practice: its own pre-flight guards, reading the media bytes, and
 * preparation steps (uploading media as unpublished objects, opening an upload
 * session) that cannot produce a post. Those are safe to repeat, and they are
 * most of the error surface, so the caller keeps its retry there.
 *
 * A platform error answer to the CREATING request does NOT qualify, however
 * clearly it says "refused". It only describes that one request, while the flag
 * is a claim about the JOB: an earlier attempt may have created the post and
 * lost the answer (timeout, killed worker), and the platform may then refuse the
 * retry precisely BECAUSE the post exists (Facebook #506 DUPLICATE_POST).
 * Errors from a dispatched creating request carry `context.feed_dispatched =
 * true`, which is REQUIRED on them: the caller must treat their outcome as
 * unknown, must not retry them, and must never put that job back on a publish
 * path. `retryable` does NOT decide this — it says whether the CALL could
 * succeed later, never whether repeating it is safe.
 *
 * The flag name is historical (Facebook's `/feed`); it means "the request that
 * creates the post has been dispatched" on every platform, TikTok's
 * `video/init/` included.
 */

/**
 * The half of a platform that can HOLD a post until its hour (E8.6). Optional
 * on ChannelPublisher: a platform without it keeps the old behaviour (the queue
 * holds the job and publishes at T), which is what TikTok does in Phase 2.
 *
 * Contract for every implementer:
 * - `schedulePost` returns only when the platform ACCEPTED the schedule, with
 *   the id of the object it now holds; anything else throws (never a silent
 *   "probably fine"), carrying the post-creation evidence flag documented
 *   above. Here `platform_created_nothing` also lets the caller fall back to
 *   publishing at the hour without any risk of a double post.
 * - `getPostState` never guesses: no proof means `unknown`, with a reason.
 * - `deleteScheduledPost` returns TRUE only when the platform confirmed it no
 *   longer holds the post, and FALSE only when the platform positively reported
 *   that it never held it. Anything else — including an answer the implementer
 *   cannot interpret — throws, because "we could not confirm" must never reach
 *   the caller as "it is gone". The Vietnamese `userMessage` of that error says
 *   the post may still publish and must be removed by hand on the Page.
 */
export interface ScheduledPublisher {
  schedulePost(input: SchedulePostInput): Promise<SchedulePostResult>;
  getPostState(input: RemotePostQuery): Promise<RemotePostState>;
  deleteScheduledPost(input: RemotePostQuery): Promise<boolean>;
}

/**
 * Contract for every implementer:
 * - Throws AppError('TOKEN_EXPIRED') when the credential is dead — the caller
 *   blocks the job instead of retrying, but ONLY when the error also proves
 *   `platform_created_nothing`: a 190 answered TO the creating request says the
 *   token died, not that the Page is empty.
 * - Throws AppError('META_ERROR') for anything else, with the platform error
 *   code/subcode in `context` so the log names the real cause.
 * - EVERY error carries the post-creation evidence flag documented above
 *   (`platform_created_nothing` / `feed_dispatched`). Without it the caller must
 *   assume a post may exist and stops the job, so a forgotten flag costs posts.
 * - Never retries internally: retry policy belongs to the usecase + queue.
 */
export interface ChannelPublisher {
  publishImagePost(input: PublishImagePostInput): Promise<PublishResult>;
  /** Phase 2 (E5.3/E5.4). Same guarantees as publishImagePost. */
  publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult>;
  /** Present only on platforms that hold a scheduled post themselves (E8.6). */
  readonly scheduled?: ScheduledPublisher;
}
