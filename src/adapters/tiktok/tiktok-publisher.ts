import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelPublisher,
  PublishImagePostInput,
  PublishResult,
  PublishVideoPostInput,
} from "@/core/ports/publisher";

import type { TikTokClient } from "./tiktok-client";
import { mapTikTokError } from "./tiktok-error-map";

/**
 * E6 — publish one video to a TikTok account (Content Posting API v2).
 *
 * Flow, in the order TikTok's docs mandate:
 *
 *   1. POST post/publish/creator_info/query/
 *      -> privacy_level_options[], max_video_post_duration_sec
 *      NOT optional: the docs require querying it before every post, and it is
 *      the only place that says which privacy levels this account allows.
 *   2. local checks: our configured privacy level must be in that list, and the
 *      clip must fit the account's duration cap. Both are refused HERE, before
 *      TikTok downloads a single byte.
 *   3. POST post/publish/video/init/  source = PULL_FROM_URL, video_url = our
 *      signed media URL -> { publish_id, upload_url }
 *   4. POST post/publish/status/fetch/ until PUBLISH_COMPLETE / FAILED.
 *
 * PULL_FROM_URL (not FILE_UPLOAD) because the worker never holds the bytes: it
 * has a signed, time-limited URL (E3.6) and TikTok fetches it.
 * PENDING(tiktok-domain-verify): PULL_FROM_URL only works from a domain
 * verified in the TikTok Developer Portal — MEDIA_PUBLIC_BASE_URL must be that
 * domain, or every post fails with url_ownership_unverified. Nothing in code
 * can check this; it is a deployment step.
 *
 * PENDING(tiktok-live-verify): NOT run against a real TikTok account from this
 * machine. Live publishing is blocked upstream by the app audit (E0.3) and the
 * domain verification (E0.4); until both land, an unaudited app can only post
 * SELF_ONLY (see the error map).
 */

const CREATOR_INFO_PATH = "post/publish/creator_info/query/";
const INIT_PATH = "post/publish/video/init/";
const STATUS_PATH = "post/publish/status/fetch/";

/** TikTok's documented title limit, counted in UTF-16 code units. */
export const TIKTOK_TITLE_MAX_LENGTH = 2200;
/** Publish is asynchronous; these bound the wait. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

const CreatorInfoSchema = z.object({
  privacy_level_options: z.array(z.string()).min(1),
  max_video_post_duration_sec: z.number().positive().optional(),
  creator_username: z.string().optional(),
  comment_disabled: z.boolean().optional(),
  duet_disabled: z.boolean().optional(),
  stitch_disabled: z.boolean().optional(),
});

const InitSchema = z.object({
  publish_id: z.string().trim().min(1).max(64),
  upload_url: z.string().trim().max(256).optional(),
});

const StatusSchema = z.object({
  status: z.string().trim().min(1),
  fail_reason: z.string().optional(),
  /**
   * Spelled exactly like this in TikTok's response (their typo, not ours).
   * PENDING(tiktok-live-verify): present only for public posts, per the docs.
   */
  publicaly_available_post_id: z.array(z.string()).optional(),
});

export interface TikTokPublisherDeps {
  client: TikTokClient;
  logger: Logger;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function makeTikTokPublisher(deps: TikTokPublisherDeps): ChannelPublisher {
  const logger = deps.logger.child({ component: "tiktok-publisher" });
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  return {
    async publishImagePost(input: PublishImagePostInput): Promise<PublishResult> {
      // The photo API exists (source PULL_FROM_URL with post_mode PHOTO), but it
      // is out of scope for this phase: nothing upstream produces a TikTok photo
      // post, and shipping an untested second flow is how a "supported" feature
      // fails at the worst moment.
      throw new AppError("INVALID_INPUT", {
        message: "TikTok publisher accepts video posts only in this phase",
        userMessage: "Kênh TikTok hiện chỉ đăng được video — bài ảnh chưa hỗ trợ.",
        context: {
          tenant_id: input?.tenantId ?? null,
          channel: input?.channel?.channelId ?? null,
          provider: "tiktok",
          retryable: false,
        },
      });
    },

    async publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult> {
      // --- Edge cases first --------------------------------------------------
      const channel = input?.channel;
      const caption = typeof input?.caption === "string" ? input.caption.trim() : "";
      const videoUrl = typeof input?.videoUrl === "string" ? input.videoUrl.trim() : "";

      if (!channel || channel.platform !== "tiktok" || !channel.accessToken?.trim()) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "TikTok publisher needs a tiktok channel with an access token",
          context: {
            tenant_id: input?.tenantId ?? null,
            channel: channel?.channelId ?? null,
            platform: channel?.platform ?? null,
            provider: "tiktok",
          },
        });
      }
      if (input?.target !== "video") {
        // TikTok has no separate Reels surface: every video IS the feed.
        throw new AppError("INVALID_INPUT", {
          message: `TikTok has no "${String(input?.target)}" target; use "video"`,
          userMessage:
            'TikTok không có định dạng Reels riêng — chọn định dạng video cho kênh TikTok.',
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            provider: "tiktok",
            target: input?.target ?? null,
            retryable: false,
          },
        });
      }
      if (!/^https?:\/\/\S+$/i.test(videoUrl)) {
        throw new AppError("INVALID_INPUT", {
          message: "publishVideoPost needs a public http(s) video URL",
          userMessage: "Video chưa có liên kết công khai — TikTok không tải về được.",
          context: { tenant_id: input.tenantId, channel: channel.channelId, provider: "tiktok" },
        });
      }
      if (caption.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to publish a TikTok video without a caption",
          userMessage: "Bài đăng chưa có nội dung — không đăng.",
          context: { tenant_id: input.tenantId, channel: channel.channelId, provider: "tiktok" },
        });
      }

      const options = channel.tiktok;
      if (!options?.privacyLevel) {
        // privacy_level is REQUIRED by the API; guessing one would post a video
        // to the wrong audience.
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "TikTok channel has no privacyLevel configured",
          userMessage:
            "Kênh TikTok chưa cấu hình mức riêng tư (privacy level) — bổ sung trước khi đăng.",
          context: { tenant_id: input.tenantId, channel: channel.channelId, provider: "tiktok" },
        });
      }

      const logContext = {
        tenant_id: input.tenantId,
        channel: channel.channelId,
        provider: "tiktok",
        idempotency_key: input.idempotencyKey,
      };
      const log = logger.child(logContext);
      const title = truncateUtf16(caption, TIKTOK_TITLE_MAX_LENGTH);

      // --- 1. creator_info (mandatory before every post) ---------------------
      const creatorRaw = await deps.client.post({
        path: CREATOR_INFO_PATH,
        body: {},
        accessToken: channel.accessToken,
        context: { ...logContext, step: "creator_info" },
      });
      const creator = CreatorInfoSchema.safeParse(creatorRaw.data);
      if (!creator.success) {
        throw unusable(creatorRaw.data, logContext, "creator_info", creator.error);
      }

      // --- 2. local gates ----------------------------------------------------
      if (!creator.data.privacy_level_options.includes(options.privacyLevel)) {
        throw new AppError("PUBLISH_FAILED", {
          message: `privacy level ${options.privacyLevel} is not allowed for this account`,
          userMessage: `TikTok không cho phép mức riêng tư "${options.privacyLevel}" với tài khoản này. Các mức hợp lệ: ${creator.data.privacy_level_options.join(", ")}.`,
          context: {
            ...logContext,
            step: "creator_info",
            reason: "PRIVACY_LEVEL_MISMATCH",
            configured: options.privacyLevel,
            allowed: creator.data.privacy_level_options,
            retryable: false,
          },
        });
      }
      const maxDuration = creator.data.max_video_post_duration_sec;
      const durationSec = typeof input.durationSec === "number" ? input.durationSec : null;
      if (maxDuration && durationSec && durationSec > maxDuration) {
        throw new AppError("VIDEO_SPEC_INVALID", {
          message: `video is ${durationSec}s, the account allows ${maxDuration}s`,
          userMessage: `Video dài ${formatSeconds(durationSec)} — tài khoản TikTok này chỉ cho phép tối đa ${formatSeconds(maxDuration)}.`,
          context: {
            ...logContext,
            step: "creator_info",
            reason: "DURATION_ABOVE_ACCOUNT_LIMIT",
            duration_sec: durationSec,
            max_duration_sec: maxDuration,
            retryable: false,
          },
        });
      }

      // --- 3. init (PULL_FROM_URL) ------------------------------------------
      const initRaw = await deps.client.post({
        path: INIT_PATH,
        body: {
          post_info: {
            title,
            privacy_level: options.privacyLevel,
            disable_duet: options.disableDuet ?? false,
            disable_stitch: options.disableStitch ?? false,
            disable_comment: options.disableComment ?? false,
            // The captions of this product are written by an LLM: declaring it
            // is TikTok policy, and the default therefore stays true.
            is_aigc: options.isAigc,
          },
          source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
        },
        accessToken: channel.accessToken,
        context: { ...logContext, step: "init" },
      });
      const init = InitSchema.safeParse(initRaw.data);
      if (!init.success) throw unusable(initRaw.data, logContext, "init", init.error);

      log.info("TikTok publish initiated", {
        publish_id: init.data.publish_id,
        privacy_level: options.privacyLevel,
        is_aigc: options.isAigc,
        title_length: title.length,
      });

      // --- 4. poll until the post exists or fails ---------------------------
      const startedAt = now();
      let polls = 0;
      for (;;) {
        const statusRaw = await deps.client.post({
          path: STATUS_PATH,
          body: { publish_id: init.data.publish_id },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "status", publish_id: init.data.publish_id },
        });
        polls += 1;
        const parsed = StatusSchema.safeParse(statusRaw.data);
        if (!parsed.success) throw unusable(statusRaw.data, logContext, "status", parsed.error);
        const status = parsed.data.status.toUpperCase();

        if (status === "PUBLISH_COMPLETE") {
          // The public post id is only there for public posts; the publish id is
          // always there and is what TikTok support asks for.
          const postId = parsed.data.publicaly_available_post_id?.[0] ?? init.data.publish_id;
          log.info("TikTok video published", {
            publish_id: init.data.publish_id,
            post_id: postId,
            polls,
            duration_ms: now() - startedAt,
          });
          return { postId, url: permalink(channel.tiktok?.openId ?? null, postId) };
        }

        if (status === "FAILED") {
          const failReason = parsed.data.fail_reason ?? "unknown";
          // TikTok reports the real cause as a slug in fail_reason: run it
          // through the same table as an HTTP error so the operator gets the
          // same sentence either way.
          throw mapFailReason(failReason, {
            ...logContext,
            step: "status",
            publish_id: init.data.publish_id,
            polls,
          });
        }

        if (now() - startedAt >= pollTimeoutMs) {
          // Neither published nor failed: TikTok may still finish it. Say so —
          // a retry could create a SECOND video, so this is not retryable.
          throw new AppError("PUBLISH_FAILED", {
            message: `TikTok still ${status} after ${pollTimeoutMs}ms`,
            userMessage:
              "TikTok chưa xử lý xong video sau thời gian chờ — kiểm tra trên TikTok trước khi đăng lại để tránh trùng bài.",
            context: {
              ...logContext,
              step: "status",
              publish_id: init.data.publish_id,
              last_status: status,
              polls,
              timeout_ms: pollTimeoutMs,
              retryable: false,
              alert: "OPERATOR_ATTENTION",
            },
          });
        }

        await sleep(pollIntervalMs);
      }
    },
  };
}

// --- helpers ----------------------------------------------------------------

/** Reuses the error table: fail_reason carries the same slugs as error.code. */
function mapFailReason(failReason: string, context: Record<string, unknown>): AppError {
  return mapTikTokError({
    error: { code: failReason, message: `publish failed: ${failReason}` },
    context: { ...context, reason: "PUBLISH_STATUS_FAILED" },
  });
}

/**
 * TikTok titles are capped in UTF-16 code units. Slicing at the limit can split
 * a surrogate pair (an emoji) in half; trimming that lone half keeps the string
 * valid instead of sending a broken character.
 */
export function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastCode = cut.charCodeAt(cut.length - 1);
  // 0xD800..0xDBFF is a high surrogate: its partner was cut off.
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut;
}

function permalink(openId: string | null, postId: string): string | null {
  // PENDING(tiktok-live-verify): the canonical permalink needs the creator's
  // @username, which creator_info returns but the connect flow does not store
  // yet. Returning null beats returning a link that 404s.
  return openId && /^\d+$/.test(postId) ? null : null;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1).replace(".", ",")} giây`;
}

function unusable(
  raw: unknown,
  context: Record<string, unknown>,
  step: string,
  error: z.ZodError,
): AppError {
  return new AppError("PUBLISH_FAILED", {
    message: `TikTok answered ${step} without the expected fields`,
    userMessage:
      "TikTok trả về dữ liệu không đọc được — cần kiểm tra thủ công trên TikTok trước khi đăng lại.",
    context: {
      ...context,
      step,
      issues: error.issues.map((issue) => issue.path.join(".")),
      response_keys: typeof raw === "object" && raw !== null ? Object.keys(raw) : null,
      retryable: false,
    },
  });
}
