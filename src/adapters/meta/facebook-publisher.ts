import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { HANDOFF_MIN_LEAD_MS, MAX_ALBUM_MEDIA, toUnixSeconds } from "@/core/domain/post-job";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelConfig,
  ChannelPublisher,
  PublishImagePostInput,
  PublishMediaItem,
  PublishResult,
  PublishVideoPostInput,
  RemotePostQuery,
  RemotePostState,
  SchedulePostInput,
  SchedulePostResult,
  ScheduledPublisher,
} from "@/core/ports/publisher";

import type { GraphClient, GraphFilePart } from "./graph-client";

/**
 * E5.2 — publish an image post on a Facebook Page.
 *
 * Two shapes, both plain Graph API calls, both sending the BYTES:
 *
 *   1 photo   POST /{page-id}/photos        source=<bytes> message=<caption>
 *             -> { id, post_id }            (published straight away)
 *
 *   N photos  POST /{page-id}/photos        source=<bytes> published=false
 *             for each photo, then
 *             POST /{page-id}/feed          message=<caption>
 *                                           attached_media[i]={"media_fbid":"<id>"}
 *             -> { id }                     (the album post)
 *
 * WHY BYTES AND NOT `url=`: with a URL, Facebook downloads the file itself and
 * abandons the attempt around 30s (Graph code 324, "Missing or invalid image
 * file"). Measured on one real 10-photo post: 4 of 10 photos accepted, three
 * hangs of exactly 29.5s. The same 10 photos uploaded as multipart `source`
 * went 10/10 in 41.8s on the same Page — because the side that waits is now the
 * worker, and the worker may wait. It also removes the dependency on a publicly
 * reachable media URL entirely.
 *
 * The bytes are read ONE FILE AT A TIME, immediately before that file's upload
 * (`PublishMediaItem.readBytes`): an album is up to 10 files of ~9MB and the
 * worker runs several jobs in parallel.
 *
 * There is no idempotency key in this API. Publishing exactly once is therefore
 * guaranteed upstream: the unique index on post_job + the `queued -> publishing`
 * claim (business rule 4). This adapter never retries on its own.
 *
 * The multipart shape follows the Apps Script flow that has been posting to the
 * real Page for months (`source: file.getBlob()`, `published=false`, then
 * `/feed` with `attached_media[i]`) and the 10/10 run reproduced on that Page.
 * THIS adapter's own first run on a real Page is still pending.
 */

/** A published photo answers with both ids; an unpublished one only with `id`. */
const PhotoResponseSchema = z.object({
  id: z.string().min(1),
  post_id: z.string().min(1).optional(),
});

const FeedResponseSchema = z.object({
  id: z.string().min(1),
});

/**
 * GET /{post-id}?fields=... for the reconciliation sweep (E8.6).
 *
 * Every field is optional but `id`: Meta returns a field only when the token may
 * read it, and a missing `is_published` must become "unknown", never "published"
 * (see the port contract on RemotePostState).
 *
 * PENDING(graph-reconcile-verify): the field NAMES follow Meta's Page Post
 * reference (`is_published`, `permalink_url`, `created_time`,
 * `scheduled_publish_time`). They have not been read back from a real scheduled
 * post from this machine — confirm on the first live schedule before trusting
 * the sweep to settle jobs unattended.
 */
const PostStateSchema = z.object({
  id: z.string().min(1),
  is_published: z.boolean().optional(),
  permalink_url: z.string().min(1).optional(),
  created_time: z.string().min(1).optional(),
  /** Unix SECONDS on an unpublished post. */
  scheduled_publish_time: z.union([z.number(), z.string()]).optional(),
});

/** DELETE /{post-id} answers { success: true }. */
const DeleteResponseSchema = z.object({
  success: z.boolean().optional(),
});

/**
 * Graph's "Object with ID X does not exist, cannot be loaded due to missing
 * permissions, or does not support this operation" — code 100 / subcode 33.
 *
 * Note what that sentence actually covers: a deleted post, a token for another
 * Page, a revoked permission and a Page that was reconnected under a new token
 * all produce it. It therefore means "we could not read the object", NEVER "the
 * object is gone".
 */
const OBJECT_NOT_READABLE_SUBCODE = 33;

/** Reason reported to callers for the answer above. Machine-readable, logged. */
export const OBJECT_NOT_READABLE_REASON = "OBJECT_NOT_READABLE_100_33";

/** POST /{page-id}/videos answers with the video id (and sometimes post_id). */
const VideoResponseSchema = z.object({
  id: z.string().min(1),
  post_id: z.string().min(1).optional(),
});

/** Reels start phase: the id to address in the following phases. */
const ReelsStartSchema = z.object({
  video_id: z.string().min(1),
  upload_url: z.string().min(1).optional(),
});

const ReelsFinishSchema = z.object({
  success: z.boolean().optional(),
  post_id: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});

export interface FacebookPublisherDeps {
  graph: GraphClient;
  logger: Logger;
}

export function makeFacebookPublisher(deps: FacebookPublisherDeps): ChannelPublisher {
  const logger = deps.logger.child({ component: "facebook-publisher" });

  return {
    async publishImagePost(input: PublishImagePostInput): Promise<PublishResult> {
      // --- Edge cases first --------------------------------------------------
      const { channel, media, caption, pageId, logContext } = assertImagePost(input);
      const log = logger.child(logContext);

      // --- Single photo: one call, published immediately ---------------------
      if (media.length === 1) {
        const file = await readPart(media[0], 0, logContext);
        const raw = await deps.graph.postMultipart({
          path: `${pageId}/photos`,
          params: { message: caption, published: "true" },
          files: [file],
          accessToken: channel.accessToken,
          context: {
            ...logContext,
            step: "photos.single",
            drive_file_id: media[0].driveFileId,
            file_name: file.fileName,
            bytes: file.bytes.length,
          },
        });
        const parsed = PhotoResponseSchema.safeParse(raw);
        if (!parsed.success) throw unusableResponse(raw, parsed.error, logContext, "photos.single");

        // post_id is the FEED post ("<page>_<post>"); id is the photo object.
        const postId = parsed.data.post_id ?? parsed.data.id;
        log.info("Single photo post published", { post_id: postId, photo_id: parsed.data.id });
        return { postId, url: permalink(postId) };
      }

      // --- Album: upload unpublished photos, then one feed post -------------
      const mediaFbIds = await uploadAlbumPhotos(deps, channel, media, logContext);

      const params: Record<string, string> = { message: caption };
      mediaFbIds.forEach((mediaFbId, index) => {
        params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: mediaFbId });
      });

      const raw = await deps.graph.post({
        path: `${pageId}/feed`,
        params,
        accessToken: channel.accessToken,
        context: { ...logContext, step: "feed", media_count: mediaFbIds.length },
      });
      const parsed = FeedResponseSchema.safeParse(raw);
      if (!parsed.success) throw unusableResponse(raw, parsed.error, logContext, "feed");

      log.info("Album post published", {
        post_id: parsed.data.id,
        media_count: mediaFbIds.length,
        photo_ids: mediaFbIds,
      });
      return { postId: parsed.data.id, url: permalink(parsed.data.id) };
    },

    scheduled: makeFacebookScheduledPublisher(deps, logger),

    /**
     * E5.3/E5.4 — one video, either into the feed or as a Reel.
     *
     * FEED   POST /{page-id}/videos        file_url=<url> description=<caption>
     *        -> { id }                     Meta downloads and encodes it.
     *
     * REELS  three phases (Meta's "Publish Reels" flow):
     *        1. POST /{page-id}/video_reels  upload_phase=start
     *           -> { video_id, upload_url }
     *        2. transfer the bytes. We publish BY URL, so this adapter uses the
     *           hosted-file variant of the upload phase (`file_url` on the
     *           rupload host) instead of streaming bytes we do not have.
     *        3. POST /{page-id}/video_reels  upload_phase=finish
     *           video_id=<id> video_state=PUBLISHED description=<caption>
     *
     * PENDING(graph-video-verify): NOT run against a real Page from this
     * machine. The field names follow Meta's Pages/Reels reference, but three
     * things must be confirmed on the first live test: (a) that the reels
     * upload phase accepts a hosted `file_url` for a Page (documented for the
     * resumable protocol, and the alternative is downloading the file into the
     * worker); (b) which id the finish phase returns as the permalink id;
     * (c) whether `video_state=PUBLISHED` needs a separate publish call when the
     * encoding is not finished yet. Until then this path stays behind the
     * Phase 1 format guard in create-post-batch.
     */
    async publishVideoPost(input: PublishVideoPostInput): Promise<PublishResult> {
      // --- Edge cases first --------------------------------------------------
      const channel = input?.channel;
      const caption = typeof input?.caption === "string" ? input.caption.trim() : "";
      const videoUrl = typeof input?.videoUrl === "string" ? input.videoUrl.trim() : "";
      const target = input?.target;

      if (!channel || channel.platform !== "facebook" || !channel.externalId?.trim()) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Facebook publisher needs a facebook channel with a Page id",
          context: {
            tenant_id: input?.tenantId ?? null,
            channel: channel?.channelId ?? null,
            platform: channel?.platform ?? null,
          },
        });
      }
      if (!/^https?:\/\/\S+$/i.test(videoUrl)) {
        throw new AppError("INVALID_INPUT", {
          message: "publishVideoPost needs a public http(s) video URL",
          userMessage: "Video chưa có liên kết công khai — Facebook không tải về được.",
          context: { tenant_id: input.tenantId, channel: channel.channelId },
        });
      }
      if (caption.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to publish a video without a caption",
          userMessage: "Bài đăng chưa có nội dung — không đăng.",
          context: { tenant_id: input.tenantId, channel: channel.channelId },
        });
      }
      if (target !== "video" && target !== "reels") {
        throw new AppError("INVALID_INPUT", {
          message: `Unknown video target "${String(target)}"`,
          userMessage: "Định dạng video không hợp lệ.",
          context: { tenant_id: input.tenantId, channel: channel.channelId, target },
        });
      }

      const pageId = channel.externalId.trim();
      const logContext = {
        tenant_id: input.tenantId,
        channel: channel.channelId,
        page_id: pageId,
        idempotency_key: input.idempotencyKey,
        target,
      };
      const log = logger.child(logContext);

      // --- Feed video: one call ---------------------------------------------
      if (target === "video") {
        const raw = await deps.graph.post({
          path: `${pageId}/videos`,
          params: { file_url: videoUrl, description: caption },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "videos" },
        });
        const parsed = VideoResponseSchema.safeParse(raw);
        if (!parsed.success) throw unusableResponse(raw, parsed.error, logContext, "videos");

        const postId = parsed.data.post_id ?? parsed.data.id;
        log.info("Video post published", { post_id: postId, video_id: parsed.data.id });
        return { postId, url: permalink(postId) };
      }

      // --- Reels: start -> upload -> finish ----------------------------------
      const startRaw = await deps.graph.post({
        path: `${pageId}/video_reels`,
        params: { upload_phase: "start" },
        accessToken: channel.accessToken,
        context: { ...logContext, step: "reels.start" },
      });
      const start = ReelsStartSchema.safeParse(startRaw);
      if (!start.success) throw unusableResponse(startRaw, start.error, logContext, "reels.start");
      const videoId = start.data.video_id;

      // Hosted-file transfer: the bytes never pass through this process.
      await deps.graph.postAbsolute({
        url: start.data.upload_url ?? `${REELS_UPLOAD_BASE_URL}/${videoId}`,
        headers: {
          Authorization: `OAuth ${channel.accessToken}`,
          file_url: videoUrl,
        },
        context: { ...logContext, step: "reels.upload", video_id: videoId },
      });

      const finishRaw = await deps.graph.post({
        path: `${pageId}/video_reels`,
        params: {
          upload_phase: "finish",
          video_id: videoId,
          video_state: "PUBLISHED",
          description: caption,
        },
        accessToken: channel.accessToken,
        context: { ...logContext, step: "reels.finish", video_id: videoId },
      });
      const finish = ReelsFinishSchema.safeParse(finishRaw);
      if (!finish.success) throw unusableResponse(finishRaw, finish.error, logContext, "reels.finish");
      if (finish.data.success === false) {
        // An explicit "no" with a 200 body: never call that published.
        throw new AppError("META_ERROR", {
          message: "Reels finish phase reported success=false",
          userMessage: "Facebook không đăng được Reel này — xem nhật ký để biết chi tiết.",
          context: { ...logContext, step: "reels.finish", video_id: videoId, retryable: false },
        });
      }

      // PENDING(graph-video-verify): which id is the permalink id.
      const postId = finish.data.post_id ?? finish.data.id ?? videoId;
      log.info("Reel published", { post_id: postId, video_id: videoId });
      return { postId, url: permalink(postId) };
    },
  };
}

/**
 * E8.6 — the half of this adapter that lets FACEBOOK hold the post until its
 * hour, instead of the queue holding it here.
 *
 *   for each photo   POST /{page-id}/photos   source=<bytes> published=false
 *   then             POST /{page-id}/feed     message=<caption>
 *                                             attached_media[i]=...
 *                                             published=false
 *                                             scheduled_publish_time=<unix s>
 *   -> { id }        the post Facebook now holds
 *
 * The upload half is the SAME code the immediate path runs (uploadAlbumPhotos):
 * the only difference between "đăng ngay" and "hẹn giờ" is two extra fields on
 * the /feed call.
 *
 * Timing (measured on a real Page, see HANDOFF_* in core/domain/post-job):
 * Meta refuses a `scheduled_publish_time` less than ~9-10 minutes ahead, and
 * more than 30 days ahead. The lead is the CALLER's business rule; the guard
 * here only refuses what would certainly be wasted upload time.
 */
function makeFacebookScheduledPublisher(
  deps: FacebookPublisherDeps,
  parentLogger: Logger,
): ScheduledPublisher {
  return {
    async schedulePost(input: SchedulePostInput): Promise<SchedulePostResult> {
      // --- Edge cases first --------------------------------------------------
      const { channel, media, caption, pageId, logContext } = assertImagePost(input);
      const publishAt = input?.publishAt;
      if (!(publishAt instanceof Date) || !Number.isFinite(publishAt.getTime())) {
        throw new AppError("INVALID_INPUT", {
          message: "schedulePost requires a publishAt date",
          userMessage: "Giờ hẹn đăng không hợp lệ — không giao lịch cho Facebook.",
          context: {
            ...logContext,
            reason: "PUBLISH_AT_NOT_A_DATE",
            retryable: false,
            // Refused HERE: Facebook was never called, so no post exists.
            platform_created_nothing: true,
          },
        });
      }
      const leadMs = publishAt.getTime() - Date.now();
      if (leadMs < HANDOFF_MIN_LEAD_MS) {
        // Refused BEFORE the album upload: Facebook would reject the /feed call
        // with #100 anyway, after we spent minutes pushing the photos.
        throw new AppError("INVALID_INPUT", {
          message: `schedulePost needs at least ${HANDOFF_MIN_LEAD_MS}ms of lead, got ${leadMs}ms`,
          userMessage:
            "Giờ hẹn quá gần (Facebook đòi tối thiểu ~10 phút) — không giao lịch, sẽ đăng theo đường thường.",
          context: {
            ...logContext,
            reason: "PUBLISH_AT_TOO_SOON",
            lead_ms: leadMs,
            min_lead_ms: HANDOFF_MIN_LEAD_MS,
            retryable: false,
            // Nothing was uploaded and /feed was never called: the caller can
            // safely fall back to publishing at the hour (no double post).
            platform_created_nothing: true,
          },
        });
      }

      const log = parentLogger.child(logContext);
      const scheduledPublishTime = toUnixSeconds(publishAt);

      const mediaFbIds = await uploadAlbumPhotos(deps, channel, media, {
        ...logContext,
        scheduled_publish_time: scheduledPublishTime,
      });

      const params: Record<string, string> = {
        message: caption,
        published: "false",
        scheduled_publish_time: String(scheduledPublishTime),
      };
      mediaFbIds.forEach((mediaFbId, index) => {
        params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: mediaFbId });
      });

      let raw: Record<string, unknown>;
      try {
        raw = await deps.graph.post({
          path: `${pageId}/feed`,
          params,
          accessToken: channel.accessToken,
          context: {
            ...logContext,
            step: "feed.scheduled",
            media_count: mediaFbIds.length,
            scheduled_publish_time: scheduledPublishTime,
          },
        });
      } catch (error) {
        // A Graph error BODY means the schedule was REFUSED and no post was
        // created — Graph answers with the new object's id or with an error,
        // never both. Facebook's #100 for a `scheduled_publish_time` under the
        // ~10-minute minimum lands here, and the caller must be able to fall
        // back to publishing at the hour instead of failing the job for good.
        // A transport failure (no answer at all) is NOT marked: after a timeout
        // the post may well exist.
        if (!isGraphRefusal(error)) throw error;
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "feed.scheduled",
          scheduled_publish_time: scheduledPublishTime,
          platform_created_nothing: true,
        });
      }
      const parsed = FeedResponseSchema.safeParse(raw);
      if (!parsed.success) throw unusableResponse(raw, parsed.error, logContext, "feed.scheduled");

      log.info("Post handed over to Facebook's scheduler", {
        post_id: parsed.data.id,
        media_count: mediaFbIds.length,
        photo_ids: mediaFbIds,
        scheduled_publish_time: scheduledPublishTime,
        publish_at: publishAt.toISOString(),
        lead_ms: leadMs,
      });
      return { scheduledPostId: parsed.data.id, publishAt };
    },

    /**
     * "Did Facebook publish it?" — the ONLY thing allowed to move a job from
     * `scheduled_on_facebook` to `published`. Never guesses: no `is_published`
     * in the answer means `unknown`, and the sweep leaves the job alone.
     */
    async getPostState(input: RemotePostQuery): Promise<RemotePostState> {
      const { channel, postId, logContext } = assertRemoteQuery(input, "getPostState");
      const log = parentLogger.child(logContext);

      let raw: Record<string, unknown>;
      try {
        raw = await deps.graph.get({
          path: postId,
          params: {
            fields: "id,is_published,permalink_url,created_time,scheduled_publish_time",
          },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "post.state" },
        });
      } catch (error) {
        if (isObjectNotReadable(error)) {
          // NOT "deleted". Graph gives this same answer for a wrong token and a
          // missing permission, so the honest report is "no verdict".
          log.warn("Graph will not show this post — no verdict on whether it still exists", {
            err: AppError.from(error, "META_ERROR", { ...logContext, step: "post.state" }),
            reason: OBJECT_NOT_READABLE_REASON,
            alert: "OPERATOR_ATTENTION",
          });
          return { state: "unknown", reason: OBJECT_NOT_READABLE_REASON };
        }
        // Anything else (token, rate limit, transport) belongs to the caller:
        // it decides retry vs alert. Rethrown with its own code intact.
        throw AppError.from(error, "META_ERROR", { ...logContext, step: "post.state" });
      }

      const parsed = PostStateSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          state: "unknown",
          reason: `UNREADABLE_RESPONSE:${parsed.error.issues.map((i) => i.path.join(".")).join(",")}`,
        };
      }
      if (parsed.data.is_published === true) {
        return {
          state: "published",
          postId: parsed.data.id,
          // Facebook's own permalink, not a string we assembled.
          url: parsed.data.permalink_url ?? permalink(parsed.data.id),
          publishedAt: parseGraphTime(parsed.data.created_time),
        };
      }
      if (parsed.data.is_published === false) {
        return {
          state: "scheduled",
          postId: parsed.data.id,
          publishAt: parseUnixSeconds(parsed.data.scheduled_publish_time),
        };
      }
      return { state: "unknown", reason: "NO_IS_PUBLISHED_FIELD" };
    },

    /**
     * Removes a post Facebook has NOT published yet (E8.6 cancel).
     *
     * ONLY a successful DELETE returns. Every other answer throws — including
     * code 100/33, which reads like "already deleted" but is also what a wrong
     * token or a missing permission produces (OBJECT_NOT_READABLE_SUBCODE).
     * Reporting that as "it is gone" would let the caller tell the operator
     * "Facebook sẽ không đăng nữa" about a post Facebook is still holding, which
     * is the exact outcome this whole flow exists to prevent.
     */
    async deleteScheduledPost(input: RemotePostQuery): Promise<boolean> {
      const { channel, postId, logContext } = assertRemoteQuery(input, "deleteScheduledPost");
      const log = parentLogger.child(logContext);

      let raw: Record<string, unknown>;
      try {
        raw = await deps.graph.del({
          path: postId,
          accessToken: channel.accessToken,
          context: { ...logContext, step: "post.delete" },
        });
      } catch (error) {
        const appError = AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "post.delete",
        });
        if (isObjectNotReadable(error)) {
          log.error("Graph refused to delete this post and gave no readable reason why", {
            err: appError,
            error_code: appError.code,
            reason: OBJECT_NOT_READABLE_REASON,
            alert: "OPERATOR_ATTENTION",
          });
          throw new AppError(appError.code, {
            message: `Graph would not delete post ${postId}: object not readable (100/33)`,
            userMessage:
              "Facebook không cho đọc/gỡ bài đã hẹn này (có thể bài đã bị xoá, cũng có thể do sai Trang hoặc thiếu quyền). " +
              "Hệ thống KHÔNG xác nhận được là bài đã biến mất — hãy vào Trang, mục bài đã lên lịch, để kiểm tra và xoá thủ công nếu bài vẫn còn.",
            context: { ...appError.context, reason: OBJECT_NOT_READABLE_REASON, retryable: false },
            cause: appError,
          });
        }
        throw appError;
      }

      const parsed = DeleteResponseSchema.safeParse(raw);
      if (parsed.success && parsed.data.success === false) {
        throw new AppError("META_ERROR", {
          message: "Graph answered success=false for a scheduled post deletion",
          userMessage:
            "Facebook không gỡ được bài đã hẹn — bài vẫn sẽ tự đăng, cần xoá trực tiếp trên Facebook.",
          context: { ...logContext, step: "post.delete", retryable: false },
        });
      }
      log.info("Scheduled post deleted on Facebook", { post_id: postId });
      return true;
    },
  };
}

/**
 * Uploads every photo of an album as an UNPUBLISHED photo object and returns the
 * ids, in album order.
 *
 * Sequential on purpose: the album order IS the order of these calls, and one
 * file at a time is what keeps a 10-photo job at one buffer, not ten.
 *
 * Shared by "đăng ngay" and "hẹn giờ" — the two paths must not drift apart in
 * how the bytes reach Facebook, because that is the part that was measured.
 */
async function uploadAlbumPhotos(
  deps: FacebookPublisherDeps,
  channel: ChannelConfig,
  media: readonly PublishMediaItem[],
  logContext: Record<string, unknown>,
): Promise<string[]> {
  const pageId = channel.externalId.trim();
  const mediaFbIds: string[] = [];
  for (const [index, item] of media.entries()) {
    const file = await readPart(item, index, logContext);
    const raw = await deps.graph.postMultipart({
      path: `${pageId}/photos`,
      params: { published: "false", temporary: "true" },
      files: [file],
      accessToken: channel.accessToken,
      context: {
        ...logContext,
        step: "photos.album",
        media_index: index,
        drive_file_id: item.driveFileId,
        file_name: file.fileName,
        bytes: file.bytes.length,
      },
    });
    const parsed = PhotoResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw unusableResponse(raw, parsed.error, logContext, `photos.album[${index}]`);
    }
    mediaFbIds.push(parsed.data.id);
  }
  return mediaFbIds;
}

interface ValidatedImagePost {
  readonly channel: ChannelConfig;
  readonly media: readonly PublishMediaItem[];
  readonly caption: string;
  readonly pageId: string;
  readonly logContext: Record<string, unknown>;
}

/**
 * The gate both image paths share: a Facebook channel with a Page id, 1..10
 * photos and a non-empty caption. Same errors as before it was extracted — the
 * immediate path is the one that has run on a real Page and must not change.
 */
function assertImagePost(input: PublishImagePostInput): ValidatedImagePost {
  const channel = input?.channel;
  const media = input?.media ?? [];
  const caption = typeof input?.caption === "string" ? input.caption.trim() : "";

  if (!channel || channel.platform !== "facebook" || !channel.externalId?.trim()) {
    throw new AppError("CHANNEL_NOT_CONFIGURED", {
      message: "Facebook publisher needs a facebook channel with a Page id",
      context: {
        tenant_id: input?.tenantId ?? null,
        channel: channel?.channelId ?? null,
        platform: channel?.platform ?? null,
      },
    });
  }
  if (media.length === 0 || media.length > MAX_ALBUM_MEDIA) {
    throw new AppError("INVALID_INPUT", {
      message: `An album needs 1..${MAX_ALBUM_MEDIA} photos, got ${media.length}`,
      userMessage: `Bài ảnh phải có từ 1 đến ${MAX_ALBUM_MEDIA} ảnh.`,
      context: { tenant_id: input.tenantId, channel: channel.channelId, media_count: media.length },
    });
  }
  if (caption.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Refusing to publish a post without a caption",
      userMessage: "Bài đăng chưa có nội dung — không đăng.",
      context: { tenant_id: input.tenantId, channel: channel.channelId },
    });
  }

  const pageId = channel.externalId.trim();
  return {
    channel,
    media,
    caption,
    pageId,
    logContext: {
      tenant_id: input.tenantId,
      channel: channel.channelId,
      page_id: pageId,
      idempotency_key: input.idempotencyKey,
    },
  };
}

function assertRemoteQuery(
  input: RemotePostQuery,
  operation: string,
): { channel: ChannelConfig; postId: string; logContext: Record<string, unknown> } {
  const channel = input?.channel;
  const postId = typeof input?.postId === "string" ? input.postId.trim() : "";
  if (!channel || channel.platform !== "facebook" || !channel.accessToken?.trim()) {
    throw new AppError("CHANNEL_NOT_CONFIGURED", {
      message: `${operation} needs a facebook channel with a token`,
      context: {
        tenant_id: input?.tenantId ?? null,
        channel: channel?.channelId ?? null,
        platform: channel?.platform ?? null,
      },
    });
  }
  if (postId.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: `${operation} needs a post id`,
      userMessage: "Thiếu mã bài trên Facebook — không kiểm tra được bài đã hẹn.",
      context: { tenant_id: input.tenantId, channel: channel.channelId, retryable: false },
    });
  }
  return {
    channel,
    postId,
    logContext: {
      tenant_id: input.tenantId,
      channel: channel.channelId,
      page_id: channel.externalId,
      post_id: postId,
    },
  };
}

/**
 * True for Graph's "I will not show you this object" (code 100 / subcode 33).
 * It is NOT evidence that the post was deleted — see OBJECT_NOT_READABLE_SUBCODE
 * — so every caller of this helper must produce an UNCERTAIN outcome.
 */
function isObjectNotReadable(error: unknown): boolean {
  if (!AppError.is(error)) return false;
  const context = error.context as { graph_code?: unknown; graph_subcode?: unknown };
  return context.graph_code === 100 && context.graph_subcode === OBJECT_NOT_READABLE_SUBCODE;
}

/**
 * True when Graph answered with an error BODY (a code): the request was refused
 * and no object was created. Graph returns either the new object's id or an
 * `error` — never both — so a refusal is proof that the Page holds no new post.
 */
function isGraphRefusal(error: unknown): boolean {
  if (!AppError.is(error)) return false;
  return typeof (error.context as { graph_code?: unknown }).graph_code === "number";
}

/** ISO 8601 with an offset, e.g. "2026-08-17T12:00:00+0000". */
function parseGraphTime(value: string | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

function parseUnixSeconds(value: number | string | undefined): Date | null {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * Reads the bytes of ONE photo, immediately before that photo is uploaded.
 *
 * Never swallows: whatever the source threw keeps its own code (MEDIA_NOT_FOUND
 * for a deleted file, DRIVE_ERROR for an outage) and gains the context that says
 * WHICH photo of WHICH post failed — the question "vì sao bài này không lên"
 * cannot be answered by "photo read failed" alone.
 *
 * An empty body is refused here, before Graph is called: Facebook answers an
 * empty part with an opaque "invalid image file" and a retry would repeat it.
 */
async function readPart(
  item: PublishMediaItem,
  index: number,
  logContext: Record<string, unknown>,
): Promise<GraphFilePart> {
  const fileName = typeof item?.fileName === "string" && item.fileName.trim().length > 0
    ? item.fileName.trim()
    : `photo-${index + 1}.jpg`;
  if (typeof item?.readBytes !== "function") {
    throw new AppError("INVALID_INPUT", {
      message: "Album item has no way to read its bytes",
      userMessage: "Không đọc được file ảnh của bài này — kiểm tra lại dữ liệu bài đăng.",
      context: {
        ...logContext,
        media_index: index,
        file_name: fileName,
        reason: "MEDIA_READER_MISSING",
        retryable: false,
      },
    });
  }

  let content;
  try {
    content = await item.readBytes();
  } catch (error) {
    throw AppError.from(error, "DRIVE_ERROR", {
      ...logContext,
      media_index: index,
      drive_file_id: item.driveFileId ?? null,
      file_name: fileName,
      step: "media.read",
    });
  }

  const bytes = content?.bytes;
  if (!bytes || bytes.length === 0) {
    throw new AppError("MEDIA_NOT_FOUND", {
      message: "Media source returned no bytes for an album item",
      userMessage: `Ảnh "${fileName}" rỗng hoặc không đọc được — không đăng.`,
      context: {
        ...logContext,
        media_index: index,
        drive_file_id: item.driveFileId ?? null,
        file_name: fileName,
        reason: "EMPTY_MEDIA_BYTES",
        retryable: false,
      },
    });
  }

  return { field: "source", fileName, bytes, mimeType: content.mimeType ?? null };
}

/** Host Meta uses for hosted/resumable uploads (not the Graph host). */
export const REELS_UPLOAD_BASE_URL = "https://rupload.facebook.com/video-upload";

/** "<page-id>_<post-id>" is a valid permalink path on facebook.com. */
function permalink(postId: string): string | null {
  return /^[0-9]+_[0-9]+$/.test(postId) ? `https://www.facebook.com/${postId}` : null;
}

/**
 * A 200 whose body we cannot read is NOT a success: the post may or may not
 * exist, and claiming "published" without an id would lose the link forever.
 * Not retryable — repeating the call could create a second post.
 */
function unusableResponse(
  raw: unknown,
  error: z.ZodError,
  context: Record<string, unknown>,
  step: string,
): AppError {
  return new AppError("META_ERROR", {
    message: `Graph answered ${step} without a usable id`,
    userMessage:
      "Facebook không trả về mã bài đăng — cần kiểm tra thủ công trên Page trước khi đăng lại.",
    context: {
      ...context,
      step,
      issues: error.issues.map((issue) => issue.path.join(".")),
      response_keys: typeof raw === "object" && raw !== null ? Object.keys(raw) : null,
      retryable: false,
    },
  });
}
