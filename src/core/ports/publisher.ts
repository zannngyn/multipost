/**
 * Publishing ports (E5/E7). Core declares WHAT it needs from a social platform;
 * adapters/meta knows HOW (Graph API). Pure TypeScript: no imports outside
 * core (docs/07 §2) — the word "Graph" must not appear below.
 *
 * TikTok (Phase 2) implements the same ChannelPublisher; nothing in core changes.
 */

import type { ChannelGroup } from "@/core/domain/channel-group";
import type { SignedMediaUrl } from "@/core/domain/media-url";
import type { PostJobMedia } from "@/core/domain/post-job";

/**
 * Mints the public, time-limited URL Graph API fetches for one media asset
 * (E3.6). Declared as a port because the MAC lives in adapters/crypto: core
 * builds posts, it never touches a signing secret.
 *
 * Both sides of the publish flow use it — create-post-batch when the job is
 * built, publish-post again right before the API call, because a job may sit in
 * the queue (spacing + retries) longer than a link lives.
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

export interface ChannelConfigRepo {
  /** Null when the tenant has no such channel (-> CHANNEL_NOT_CONFIGURED). */
  findChannel(tenantId: string, channelId: string): Promise<ChannelConfig | null>;
  listChannels(tenantId: string): Promise<readonly ChannelConfig[]>;
  /** Falls back to DEFAULT_PUBLISH_SETTINGS when the tenant set nothing. */
  getPublishSettings(tenantId: string): Promise<PublishSettings>;
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

export interface PublishImagePostInput {
  readonly tenantId: string;
  readonly channel: ChannelConfig;
  /** Final approved caption for THIS channel (brief §7.2: one per channel). */
  readonly caption: string;
  /** Ordered album, index 0 is the cover. 1..10 items. */
  readonly media: readonly PostJobMedia[];
  /**
   * The anti-duplicate tuple, passed for logging/tracing only. The Graph API has
   * no idempotency header for photo posts: the real protection is the unique
   * index + the `queued -> publishing` claim (business rule 4).
   */
  readonly idempotencyKey: string;
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
}

/**
 * Contract for every implementer:
 * - Throws AppError('TOKEN_EXPIRED') when the credential is dead — the caller
 *   blocks the job instead of retrying.
 * - Throws AppError('META_ERROR') for anything else, with the platform error
 *   code/subcode in `context` so the log names the real cause.
 * - Never retries internally: retry policy belongs to the usecase + queue.
 */
export interface ChannelPublisher {
  publishImagePost(input: PublishImagePostInput): Promise<PublishResult>;
  /** Phase 2 (E5.3/E5.4). Same guarantees as publishImagePost. */
  publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult>;
}
