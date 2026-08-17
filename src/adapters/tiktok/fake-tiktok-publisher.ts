import { AppError } from "@/core/domain/errors";
import type {
  ChannelPublisher,
  PublishImagePostInput,
  PublishResult,
  PublishVideoPostInput,
} from "@/core/ports/publisher";

import { mapTikTokError } from "./tiktok-error-map";

/**
 * Scriptable TikTok publisher for tests and the E6 smoke script.
 *
 * It exists for the same reason FakeChannelPublisher does: live TikTok posting
 * is blocked by the app audit and the domain verification (E0.3/E0.4), and
 * "how many times was TikTok called?" is the only honest way to prove that a
 * blocked job never reached the platform.
 *
 * Same failure vocabulary as the real adapter: every scripted error goes
 * through mapTikTokError, so a test asserts on the codes production produces.
 * That includes the post-creation evidence flag the port requires
 * (platform_created_nothing / feed_dispatched) — without it every scenario here
 * would fail closed in the caller and the fake would prove the opposite of what
 * production does. Each scenario below says which PHASE it stands for.
 */

export interface FakeTikTokScenario {
  /**
   * Fail this many calls with a retryable error, then succeed. Stands for a
   * rate limit at the creator_info phase: nothing was dispatched, so the caller
   * keeps its retry.
   */
  readonly transientFailures?: number;
  /**
   * Fail EVERY call with this TikTok error slug (e.g. "url_ownership_unverified"
   * — the answer to `video/init/` when the pull domain is not verified). Stands
   * for a refusal of the CREATING request: the caller must treat the outcome as
   * unknown, exactly as with a real init/ error.
   */
  readonly errorCode?: string;
  /** Publish is accepted but the status poll ends in FAILED with this slug. */
  readonly failReason?: string;
  readonly delayMs?: number;
}

export interface FakeTikTokCall {
  readonly channelId: string;
  readonly openId: string | null;
  readonly caption: string;
  readonly videoUrl: string;
  readonly privacyLevel: string | null;
  readonly isAigc: boolean | null;
  readonly at: Date;
  readonly outcome: "published" | "error";
  readonly errorCode?: string;
}

export interface FakeTikTokPublisher extends ChannelPublisher {
  readonly calls: readonly FakeTikTokCall[];
  callCount(channelId?: string): number;
  publishedCount(channelId?: string): number;
  setScenario(channelId: string, scenario: FakeTikTokScenario | null): void;
  reset(): void;
}

export function makeFakeTikTokPublisher(
  options: { scenarios?: Readonly<Record<string, FakeTikTokScenario>> } = {},
): FakeTikTokPublisher {
  const scenarios = new Map<string, FakeTikTokScenario>(Object.entries(options.scenarios ?? {}));
  const failuresSoFar = new Map<string, number>();
  const calls: FakeTikTokCall[] = [];
  let sequence = 0;

  return {
    calls,
    callCount(channelId?: string): number {
      return channelId ? calls.filter((call) => call.channelId === channelId).length : calls.length;
    },
    publishedCount(channelId?: string): number {
      return calls.filter(
        (call) => call.outcome === "published" && (!channelId || call.channelId === channelId),
      ).length;
    },
    setScenario(channelId: string, scenario: FakeTikTokScenario | null): void {
      if (scenario) scenarios.set(channelId, scenario);
      else scenarios.delete(channelId);
      failuresSoFar.delete(channelId);
    },
    reset(): void {
      calls.length = 0;
      failuresSoFar.clear();
      sequence = 0;
    },

    async publishImagePost(input: PublishImagePostInput): Promise<PublishResult> {
      // Mirrors the real adapter: photo posts are out of scope this phase.
      throw new AppError("INVALID_INPUT", {
        message: "TikTok publisher accepts video posts only in this phase",
        userMessage: "Kênh TikTok hiện chỉ đăng được video — bài ảnh chưa hỗ trợ.",
        context: {
          tenant_id: input?.tenantId ?? null,
          channel: input?.channel?.channelId ?? null,
          provider: "tiktok",
          retryable: false,
          platform_created_nothing: true,
        },
      });
    },

    async publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult> {
      const channel = input?.channel;
      if (!channel) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Fake TikTok publisher called without a channel",
          context: {
            tenant_id: input?.tenantId ?? null,
            provider: "tiktok",
            platform_created_nothing: true,
          },
        });
      }
      if (input?.target !== "video") {
        throw new AppError("INVALID_INPUT", {
          message: `TikTok has no "${String(input?.target)}" target; use "video"`,
          userMessage:
            "TikTok không có định dạng Reels riêng — chọn định dạng video cho kênh TikTok.",
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            provider: "tiktok",
            retryable: false,
            platform_created_nothing: true,
          },
        });
      }

      const scenario = scenarios.get(channel.channelId) ?? {};
      if (scenario.delayMs && scenario.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      }

      const record = (outcome: "published" | "error", errorCode?: string): void => {
        calls.push({
          channelId: channel.channelId,
          openId: channel.tiktok?.openId ?? null,
          caption: input.caption,
          videoUrl: input.videoUrl,
          privacyLevel: channel.tiktok?.privacyLevel ?? null,
          isAigc: channel.tiktok?.isAigc ?? null,
          at: new Date(),
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      };

      const context = { tenant_id: input.tenantId, channel: channel.channelId, fake: true };

      // A refusal of the CREATING request (video/init/). A refusal is not proof
      // that nothing exists — an earlier attempt may have created the video and
      // lost the answer — so it carries the dispatch flag, like the real adapter.
      if (scenario.errorCode) {
        const error = mapTikTokError({
          error: { code: scenario.errorCode, message: `Fake TikTok error ${scenario.errorCode}` },
          httpStatus: 400,
          context: { ...context, step: "init", feed_dispatched: true },
        });
        record("error", error.code);
        throw error;
      }

      const budget = scenario.transientFailures ?? 0;
      const failed = failuresSoFar.get(channel.channelId) ?? 0;
      if (failed < budget) {
        failuresSoFar.set(channel.channelId, failed + 1);
        const error = mapTikTokError({
          error: { code: "rate_limit_exceeded", message: "Fake TikTok rate limit" },
          httpStatus: 429,
          context: {
            ...context,
            step: "creator_info",
            failure_number: failed + 1,
            failure_budget: budget,
            // Before init/: repeating this cannot double-post.
            platform_created_nothing: true,
          },
        });
        record("error", error.code);
        throw error;
      }

      // Accepted at init, then rejected by the status poll.
      if (scenario.failReason) {
        const error = mapTikTokError({
          error: { code: scenario.failReason, message: `publish failed: ${scenario.failReason}` },
          // The poll runs AFTER init/, so a video may exist whatever it says.
          context: {
            ...context,
            step: "status",
            reason: "PUBLISH_STATUS_FAILED",
            feed_dispatched: true,
          },
        });
        record("error", error.code);
        throw error;
      }

      sequence += 1;
      const publishId = `v_pub_fake_${1000 + sequence}`;
      record("published");
      return { postId: publishId, url: null };
    },
  };
}
