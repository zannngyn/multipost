import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { MAX_ALBUM_MEDIA } from "@/core/domain/post-job";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelPublisher,
  PublishImagePostInput,
  PublishMediaItem,
  PublishResult,
  PublishVideoPostInput,
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
      const logContext = {
        tenant_id: input.tenantId,
        channel: channel.channelId,
        page_id: pageId,
        idempotency_key: input.idempotencyKey,
      };
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
      // Sequential on purpose: the album order IS the order of these calls, and
      // one file at a time is what keeps a 10-photo job at one buffer, not ten.
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
