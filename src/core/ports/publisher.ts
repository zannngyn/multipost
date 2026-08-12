/**
 * Publishing ports (E5/E7). Core declares WHAT it needs from a social platform;
 * adapters/meta knows HOW (Graph API). Pure TypeScript: no imports outside
 * core (docs/07 §2) — the word "Graph" must not appear below.
 *
 * TikTok (Phase 2) implements the same ChannelPublisher; nothing in core changes.
 */

import type { PostJobMedia } from "@/core/domain/post-job";

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
}
