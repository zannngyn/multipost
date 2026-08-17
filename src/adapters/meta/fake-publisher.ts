import { AppError } from "@/core/domain/errors";
import type {
  ChannelPublisher,
  PublishImagePostInput,
  PublishResult,
  PublishVideoPostInput,
  RemotePostQuery,
  RemotePostState,
  SchedulePostInput,
  SchedulePostResult,
  ScheduledPublisher,
  VideoTarget,
} from "@/core/ports/publisher";

import { mapGraphError, type GraphErrorBody } from "./graph-error-map";

/**
 * Scriptable ChannelPublisher for tests and the E7 smoke script.
 *
 * It exists because the publish flow (state machine, anti-duplicate lock, stock
 * recheck, spacing, retries) must be provable WITHOUT a Page token — and because
 * "how many times was the platform called?" is the only honest way to prove that
 * a blocked job never reached Facebook.
 *
 * Same failure vocabulary as the real adapter: every scripted error goes through
 * mapGraphError, so a test asserts on the codes production would produce.
 */

export interface FakePublishScenario {
  /** Fail this many calls with a transient error, then succeed. */
  readonly transientFailures?: number;
  /** Fail EVERY call with this Graph error body (e.g. { code: 190 }). */
  readonly graphError?: GraphErrorBody;
  /** Artificial latency, to make spacing/timing visible in the smoke script. */
  readonly delayMs?: number;
}

export interface FakePublishCall {
  readonly channelId: string;
  /**
   * "image" for a photo/album post, "video"/"reels" for the Phase 2 path, and
   * "schedule" when the post was handed to the platform instead of published
   * (E8.6) — a test proving "nothing was published yet" needs to tell them apart.
   */
  readonly kind: "image" | "schedule" | VideoTarget;
  /** Set for a "schedule" call: the hour handed to the platform. */
  readonly publishAt?: Date;
  readonly pageId: string;
  readonly caption: string;
  readonly mediaCount: number;
  /**
   * What was handed over for THIS call. Photos travel as BYTES now, so the fake
   * records what it read (asset id + byte count) instead of a URL; the video
   * path still gets one URL and records it here as its only entry.
   */
  readonly mediaUrls: readonly string[];
  /** Asset ids of the photos, in album order. Empty for a video call. */
  readonly mediaAssetIds: readonly string[];
  /** Bytes actually read per photo — 0 would mean nothing was uploaded. */
  readonly mediaBytes: readonly number[];
  readonly idempotencyKey: string;
  readonly at: Date;
  /** "scheduled" = handed over, NOT live. Never counted as published. */
  readonly outcome: "published" | "scheduled" | "error";
  readonly errorCode?: string;
}

export interface FakeChannelPublisher extends ChannelPublisher {
  readonly calls: readonly FakePublishCall[];
  callCount(channelId?: string): number;
  publishedCount(channelId?: string): number;
  /** E8.6 — how many posts were handed to the platform's scheduler. */
  scheduledCount(channelId?: string): number;
  setScenario(channelId: string, scenario: FakePublishScenario | null): void;
  /** E8.6 — what `getPostState` answers for this platform post id. */
  setRemoteState(postId: string, state: RemotePostState): void;
  /** Platform post ids this fake was asked to delete, in order. */
  readonly deletedPostIds: readonly string[];
  readonly scheduled: ScheduledPublisher;
  reset(): void;
}

export function makeFakeChannelPublisher(options: {
  scenarios?: Readonly<Record<string, FakePublishScenario>>;
} = {}): FakeChannelPublisher {
  const scenarios = new Map<string, FakePublishScenario>(Object.entries(options.scenarios ?? {}));
  const failuresSoFar = new Map<string, number>();
  const calls: FakePublishCall[] = [];
  const remoteStates = new Map<string, RemotePostState>();
  const deletedPostIds: string[] = [];
  let sequence = 0;

  const nextPostId = (pageId: string): string => {
    sequence += 1;
    return `${pageId}_${1000 + sequence}`;
  };

  return {
    calls,
    deletedPostIds,
    callCount(channelId?: string): number {
      return channelId ? calls.filter((call) => call.channelId === channelId).length : calls.length;
    },
    publishedCount(channelId?: string): number {
      return calls.filter(
        (call) => call.outcome === "published" && (!channelId || call.channelId === channelId),
      ).length;
    },
    scheduledCount(channelId?: string): number {
      return calls.filter(
        (call) => call.outcome === "scheduled" && (!channelId || call.channelId === channelId),
      ).length;
    },
    setScenario(channelId: string, scenario: FakePublishScenario | null): void {
      if (scenario) scenarios.set(channelId, scenario);
      else scenarios.delete(channelId);
      failuresSoFar.delete(channelId);
    },
    setRemoteState(postId: string, state: RemotePostState): void {
      remoteStates.set(postId, state);
    },
    reset(): void {
      calls.length = 0;
      failuresSoFar.clear();
      remoteStates.clear();
      deletedPostIds.length = 0;
      sequence = 0;
    },

    /**
     * E8.6 — the platform holds the post. Scripted by the SAME scenarios as the
     * publish paths, so a test can prove that a failed handoff never leaves a
     * post behind, and that a successful one publishes NOTHING yet.
     */
    scheduled: {
      async schedulePost(input: SchedulePostInput): Promise<SchedulePostResult> {
        const channel = input?.channel;
        if (!channel) {
          throw new AppError("CHANNEL_NOT_CONFIGURED", {
            message: "Fake publisher called without a channel",
            context: { tenant_id: input?.tenantId ?? null },
          });
        }
        if (!(input?.publishAt instanceof Date)) {
          throw new AppError("INVALID_INPUT", {
            message: "Fake schedulePost needs a publishAt date",
            userMessage: "Giờ hẹn đăng không hợp lệ — không giao lịch cho Facebook.",
            context: { tenant_id: input.tenantId, channel: channel.channelId, retryable: false },
          });
        }

        const scenario = scenarios.get(channel.channelId) ?? {};
        if (scenario.delayMs && scenario.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
        }

        // Reads the bytes like the real adapter: a handoff uploads the album.
        const items = input.media ?? [];
        const mediaBytes: number[] = [];
        for (const item of items) {
          const content = await item.readBytes();
          mediaBytes.push(content?.bytes?.length ?? 0);
        }

        const record = (outcome: "scheduled" | "error", errorCode?: string): void => {
          calls.push({
            kind: "schedule",
            channelId: channel.channelId,
            pageId: channel.externalId,
            caption: input.caption,
            mediaCount: items.length,
            mediaUrls: [],
            mediaAssetIds: items.map((item) => item.driveFileId),
            mediaBytes,
            idempotencyKey: input.idempotencyKey,
            at: new Date(),
            publishAt: input.publishAt,
            outcome,
            ...(errorCode ? { errorCode } : {}),
          });
        };

        if (scenario.graphError) {
          const error = mapGraphError({
            error: scenario.graphError,
            httpStatus: 400,
            context: { tenant_id: input.tenantId, channel: channel.channelId, fake: true },
          });
          record("error", error.code);
          throw error;
        }

        const budget = scenario.transientFailures ?? 0;
        const failed = failuresSoFar.get(channel.channelId) ?? 0;
        if (failed < budget) {
          failuresSoFar.set(channel.channelId, failed + 1);
          const error = mapGraphError({
            error: { code: 2, message: "Fake transient Graph failure" },
            httpStatus: 500,
            context: {
              tenant_id: input.tenantId,
              channel: channel.channelId,
              fake: true,
              failure_number: failed + 1,
              failure_budget: budget,
            },
          });
          record("error", error.code);
          throw error;
        }

        const scheduledPostId = nextPostId(channel.externalId);
        remoteStates.set(scheduledPostId, {
          state: "scheduled",
          postId: scheduledPostId,
          publishAt: input.publishAt,
        });
        record("scheduled");
        return { scheduledPostId, publishAt: input.publishAt };
      },

      async getPostState(input: RemotePostQuery): Promise<RemotePostState> {
        const postId = typeof input?.postId === "string" ? input.postId.trim() : "";
        // An id this fake never issued is NOT a verdict on the post: the real
        // adapter cannot tell a deleted post from a token problem either.
        return remoteStates.get(postId) ?? { state: "unknown", reason: "UNKNOWN_POST_ID" };
      },

      async deleteScheduledPost(input: RemotePostQuery): Promise<boolean> {
        const postId = typeof input?.postId === "string" ? input.postId.trim() : "";
        deletedPostIds.push(postId);
        // This fake IS the platform, so it can positively report absence:
        // false = it never held that post (the port allows that answer only
        // with proof, which the real Graph adapter never has).
        const existed = remoteStates.delete(postId);
        return existed;
      },
    },

    async publishImagePost(input: PublishImagePostInput): Promise<PublishResult> {
      const channel = input?.channel;
      if (!channel) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Fake publisher called without a channel",
          context: { tenant_id: input?.tenantId ?? null },
        });
      }

      const scenario = scenarios.get(channel.channelId) ?? {};
      if (scenario.delayMs && scenario.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      }

      const items = input.media ?? [];
      // The fake READS the bytes like the real adapter does — one file at a
      // time, in album order. Skipping it would make the smoke script prove a
      // publish path that never touches Drive or the cache.
      const mediaBytes: number[] = [];
      for (const [index, item] of items.entries()) {
        const content = await item.readBytes();
        if (!content?.bytes || content.bytes.length === 0) {
          throw new AppError("MEDIA_NOT_FOUND", {
            message: "Fake publisher was handed an empty photo",
            userMessage: `Ảnh "${item.fileName}" rỗng hoặc không đọc được — không đăng.`,
            context: {
              tenant_id: input.tenantId,
              channel: channel.channelId,
              media_index: index,
              drive_file_id: item.driveFileId,
              reason: "EMPTY_MEDIA_BYTES",
              retryable: false,
            },
          });
        }
        mediaBytes.push(content.bytes.length);
      }

      const record = (outcome: "published" | "error", errorCode?: string): void => {
        calls.push({
          kind: "image",
          channelId: channel.channelId,
          pageId: channel.externalId,
          caption: input.caption,
          mediaCount: items.length,
          mediaUrls: [],
          mediaAssetIds: items.map((item) => item.driveFileId),
          mediaBytes,
          idempotencyKey: input.idempotencyKey,
          at: new Date(),
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      };

      if (scenario.graphError) {
        const error = mapGraphError({
          error: scenario.graphError,
          httpStatus: 400,
          context: { tenant_id: input.tenantId, channel: channel.channelId, fake: true },
        });
        record("error", error.code);
        throw error;
      }

      const budget = scenario.transientFailures ?? 0;
      const failed = failuresSoFar.get(channel.channelId) ?? 0;
      if (failed < budget) {
        failuresSoFar.set(channel.channelId, failed + 1);
        // Graph code 2 = temporary platform problem -> retryable META_ERROR.
        const error = mapGraphError({
          error: { code: 2, message: "Fake transient Graph failure" },
          httpStatus: 500,
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            fake: true,
            failure_number: failed + 1,
            failure_budget: budget,
          },
        });
        record("error", error.code);
        throw error;
      }

      const postId = nextPostId(channel.externalId);
      remoteStates.set(postId, {
        state: "published",
        postId,
        url: `https://www.facebook.com/${postId}`,
        publishedAt: new Date(),
      });
      record("published");
      return { postId, url: `https://www.facebook.com/${postId}` };
    },

    /** Same scripting as the image path: scenarios are per CHANNEL, not per kind. */
    async publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult> {
      const channel = input?.channel;
      if (!channel) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Fake publisher called without a channel",
          context: { tenant_id: input?.tenantId ?? null },
        });
      }
      const target: VideoTarget = input?.target === "reels" ? "reels" : "video";
      const videoUrl = typeof input?.videoUrl === "string" ? input.videoUrl.trim() : "";
      if (videoUrl.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Fake publisher needs a video URL",
          userMessage: "Video chưa có liên kết công khai — Facebook không tải về được.",
          context: { tenant_id: input.tenantId, channel: channel.channelId, target },
        });
      }

      const scenario = scenarios.get(channel.channelId) ?? {};
      if (scenario.delayMs && scenario.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      }

      const record = (outcome: "published" | "error", errorCode?: string): void => {
        calls.push({
          kind: target,
          channelId: channel.channelId,
          pageId: channel.externalId,
          caption: input.caption,
          mediaCount: 1,
          mediaUrls: [videoUrl],
          mediaAssetIds: [],
          mediaBytes: [],
          idempotencyKey: input.idempotencyKey,
          at: new Date(),
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      };

      if (scenario.graphError) {
        const error = mapGraphError({
          error: scenario.graphError,
          httpStatus: 400,
          context: { tenant_id: input.tenantId, channel: channel.channelId, fake: true, target },
        });
        record("error", error.code);
        throw error;
      }

      const budget = scenario.transientFailures ?? 0;
      const failed = failuresSoFar.get(channel.channelId) ?? 0;
      if (failed < budget) {
        failuresSoFar.set(channel.channelId, failed + 1);
        const error = mapGraphError({
          error: { code: 2, message: "Fake transient Graph failure" },
          httpStatus: 500,
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            fake: true,
            target,
            failure_number: failed + 1,
            failure_budget: budget,
          },
        });
        record("error", error.code);
        throw error;
      }

      const postId = nextPostId(channel.externalId);
      remoteStates.set(postId, {
        state: "published",
        postId,
        url: `https://www.facebook.com/${postId}`,
        publishedAt: new Date(),
      });
      record("published");
      return { postId, url: `https://www.facebook.com/${postId}` };
    },
  };
}
