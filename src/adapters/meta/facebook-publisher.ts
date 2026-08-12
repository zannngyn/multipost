import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { MAX_ALBUM_MEDIA } from "@/core/domain/post-job";
import type { Logger } from "@/core/ports/infra";
import type { ChannelPublisher, PublishImagePostInput, PublishResult } from "@/core/ports/publisher";

import type { GraphClient } from "./graph-client";

/**
 * E5.2 — publish an image post on a Facebook Page.
 *
 * Two shapes, both plain Graph API calls:
 *
 *   1 photo   POST /{page-id}/photos        url=<image> message=<caption>
 *             -> { id, post_id }            (published straight away)
 *
 *   N photos  POST /{page-id}/photos        url=<image> published=false
 *             for each photo, then
 *             POST /{page-id}/feed          message=<caption>
 *                                           attached_media[i]={"media_fbid":"<id>"}
 *             -> { id }                     (the album post)
 *
 * The photos are uploaded BY URL: Facebook fetches them itself, so the URL must
 * be publicly reachable (an unreachable one comes back as Graph code 1609005,
 * mapped to a Vietnamese message in graph-error-map.ts).
 *
 * There is no idempotency key in this API. Publishing exactly once is therefore
 * guaranteed upstream: the unique index on post_job + the `queued -> publishing`
 * claim (business rule 4). This adapter never retries on its own.
 *
 * NOT VERIFIED against a real Page from this machine (no Page token available):
 * the request shapes follow Meta's Pages API reference, but the first real run
 * must happen on a test Page — see the report.
 */

/** A published photo answers with both ids; an unpublished one only with `id`. */
const PhotoResponseSchema = z.object({
  id: z.string().min(1),
  post_id: z.string().min(1).optional(),
});

const FeedResponseSchema = z.object({
  id: z.string().min(1),
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
        const raw = await deps.graph.post({
          path: `${pageId}/photos`,
          params: { url: media[0].url, message: caption, published: "true" },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "photos.single" },
        });
        const parsed = PhotoResponseSchema.safeParse(raw);
        if (!parsed.success) throw unusableResponse(raw, parsed.error, logContext, "photos.single");

        // post_id is the FEED post ("<page>_<post>"); id is the photo object.
        const postId = parsed.data.post_id ?? parsed.data.id;
        log.info("Single photo post published", { post_id: postId, photo_id: parsed.data.id });
        return { postId, url: permalink(postId) };
      }

      // --- Album: upload unpublished photos, then one feed post -------------
      const mediaFbIds: string[] = [];
      for (const [index, item] of media.entries()) {
        const raw = await deps.graph.post({
          path: `${pageId}/photos`,
          params: { url: item.url, published: "false", temporary: "true" },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "photos.album", media_index: index, file_name: item.fileName },
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
  };
}

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
