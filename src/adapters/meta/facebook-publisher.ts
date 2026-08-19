import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { HANDOFF_MIN_LEAD_MS, MAX_ALBUM_MEDIA, toUnixSeconds } from "@/core/domain/post-job";
import type { Logger } from "@/core/ports/infra";
import type {
  ChannelConfig,
  ChannelPublisher,
  PublishImagePostInput,
  PublishMediaItem,
  PublishProgressEvent,
  PublishProgressListener,
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
 * WHICH CALL CREATES THE POST (port contract: platform_created_nothing vs
 * feed_dispatched, and the reason every outbound call below sits in its own
 * try/catch). Everything before the creating request is safe to repeat and says
 * so; the creating request and everything after it is not:
 *
 *   image, 1 photo   /photos published=true      <- CREATES
 *   image, album     /photos published=false ... then /feed   <- CREATES
 *   video (feed)     /videos                     <- CREATES
 *   reel             video_reels start + upload  then finish  <- CREATES
 *
 * A refusal answered TO the creating request is NOT proof that nothing exists:
 * an earlier attempt may have committed the post and lost the answer, and #506
 * DUPLICATE_POST is exactly what Facebook answers next. So those errors say
 * `feed_dispatched` and the caller stops the job instead of sending it again.
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

/**
 * DELETE /{post-id} answers `{ "success": true }`.
 *
 * `success` is REQUIRED here on purpose: this schema is the only thing standing
 * between "Facebook confirmed the post is gone" and "Facebook answered 200 with
 * something we did not understand". With an optional flag, every 200 JSON object
 * without the key — an error envelope shape this client cannot read included —
 * would have passed as a confirmed deletion (port contract on
 * ScheduledPublisher.deleteScheduledPost).
 */
const DeleteResponseSchema = z.object({
  success: z.boolean(),
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
        const fileName = media[0]?.fileName ?? "";
        emitProgress(input.onProgress, log, {
          kind: "media_upload_started",
          index: 0,
          total: 1,
          fileName,
        });
        // Reading the bytes creates nothing (readPart flags that itself).
        const file = await readPart(media[0], 0, logContext);
        // No `media_upload_finished` here on purpose: on this path the upload IS
        // the post. The next event the caller sees is `creating_post`, so the
        // screen never falls back to "uploading" for a post already on the Page.
        emitProgress(input.onProgress, log, { kind: "creating_post" });
        let raw: Record<string, unknown>;
        try {
          raw = await deps.graph.postMultipart({
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
        } catch (error) {
          // `published=true`: THIS call is the one that creates the post. Once it
          // has left the process nothing coming back proves the Page is empty —
          // not a timeout, and not a Graph refusal either (an earlier attempt may
          // have committed the post and lost the answer, and #506 DUPLICATE_POST
          // is what Facebook then answers). Port contract: feed_dispatched.
          throw AppError.from(error, "META_ERROR", {
            ...logContext,
            step: "photos.single",
            feed_dispatched: true,
          });
        }
        const parsed = PhotoResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw unusableResponse(raw, parsed.error, logContext, "photos.single", {
            feed_dispatched: true,
          });
        }

        // post_id is the FEED post ("<page>_<post>"); id is the photo object.
        const postId = parsed.data.post_id ?? parsed.data.id;
        log.info("Single photo post published", { post_id: postId, photo_id: parsed.data.id });
        return { postId, url: permalink(postId) };
      }

      // --- Album: upload unpublished photos, then one feed post -------------
      let mediaFbIds: string[];
      try {
        mediaFbIds = await uploadAlbumPhotos(deps, channel, media, logContext, {
          onProgress: input.onProgress,
          log,
        });
      } catch (error) {
        // Same reasoning as the scheduled path: these calls only make
        // `published=false` photo objects, which are not posts. Whatever failed
        // here, the Page holds nothing for this job — so the caller keeps its
        // retry, and this is the bulk of the error surface.
        //
        // No `step` here on purpose: the inner error already names its own
        // (`media.read` for an unreadable photo, `photos.album` for a Graph
        // refusal), and overwriting it would answer "which photo, and doing
        // what?" with a shrug.
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          platform_created_nothing: true,
        });
      }

      const params: Record<string, string> = { message: caption };
      mediaFbIds.forEach((mediaFbId, index) => {
        params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: mediaFbId });
      });

      // Fired here, not earlier: everything above only made unpublished photo
      // objects, and this is the one call that can put a post on the Page.
      emitProgress(input.onProgress, log, { kind: "creating_post" });
      let raw: Record<string, unknown>;
      try {
        raw = await deps.graph.post({
          path: `${pageId}/feed`,
          params,
          accessToken: channel.accessToken,
          context: { ...logContext, step: "feed", media_count: mediaFbIds.length },
        });
      } catch (error) {
        // The creating request has left the process — see the single-photo path.
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "feed",
          media_count: mediaFbIds.length,
          feed_dispatched: true,
        });
      }
      const parsed = FeedResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw unusableResponse(raw, parsed.error, logContext, "feed", { feed_dispatched: true });
      }

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

      // Every guard below runs before a single request leaves this process, so
      // each one carries `platform_created_nothing` (port contract). Without it
      // the caller has to assume a video may exist and stops the job for good.
      if (!channel || channel.platform !== "facebook" || !channel.externalId?.trim()) {
        throw new AppError("CHANNEL_NOT_CONFIGURED", {
          message: "Facebook publisher needs a facebook channel with a Page id",
          context: {
            tenant_id: input?.tenantId ?? null,
            channel: channel?.channelId ?? null,
            platform: channel?.platform ?? null,
            platform_created_nothing: true,
          },
        });
      }
      if (!/^https?:\/\/\S+$/i.test(videoUrl)) {
        throw new AppError("INVALID_INPUT", {
          message: "publishVideoPost needs a public http(s) video URL",
          userMessage: "Video chưa có liên kết công khai — Facebook không tải về được.",
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            platform_created_nothing: true,
          },
        });
      }
      if (caption.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to publish a video without a caption",
          userMessage: "Bài đăng chưa có nội dung — không đăng.",
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            platform_created_nothing: true,
          },
        });
      }
      if (target !== "video" && target !== "reels") {
        throw new AppError("INVALID_INPUT", {
          message: `Unknown video target "${String(target)}"`,
          userMessage: "Định dạng video không hợp lệ.",
          context: {
            tenant_id: input.tenantId,
            channel: channel.channelId,
            target,
            platform_created_nothing: true,
          },
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
        // ONE call, and it is the creating one: Meta accepts the video and
        // publishes it. Nothing that comes back can promise the Page is empty.
        // Minimal progress by design (§2): the bytes travel from Meta's side of
        // the wire (file_url), so there is no upload here to count.
        emitProgress(input.onProgress, log, { kind: "creating_post" });
        let raw: Record<string, unknown>;
        try {
          raw = await deps.graph.post({
            path: `${pageId}/videos`,
            params: { file_url: videoUrl, description: caption },
            accessToken: channel.accessToken,
            context: { ...logContext, step: "videos" },
          });
        } catch (error) {
          throw AppError.from(error, "META_ERROR", {
            ...logContext,
            step: "videos",
            feed_dispatched: true,
          });
        }
        const parsed = VideoResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw unusableResponse(raw, parsed.error, logContext, "videos", {
            feed_dispatched: true,
          });
        }

        const postId = parsed.data.post_id ?? parsed.data.id;
        log.info("Video post published", { post_id: postId, video_id: parsed.data.id });
        return { postId, url: permalink(postId) };
      }

      // --- Reels: start -> upload -> finish ----------------------------------
      // Only the FINISH phase publishes (`video_state=PUBLISHED`). Start and
      // upload create an unpublished video container and move bytes into it —
      // the same role `published=false` photos play in an album — so a failure
      // there leaves the Page empty and stays retryable.
      // PENDING(graph-video-verify): confirm on the first live Reel that a
      // started-but-never-finished video really shows up nowhere on the Page.
      let startRaw: Record<string, unknown>;
      try {
        startRaw = await deps.graph.post({
          path: `${pageId}/video_reels`,
          params: { upload_phase: "start" },
          accessToken: channel.accessToken,
          context: { ...logContext, step: "reels.start" },
        });
      } catch (error) {
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "reels.start",
          platform_created_nothing: true,
        });
      }
      const start = ReelsStartSchema.safeParse(startRaw);
      if (!start.success) {
        throw unusableResponse(startRaw, start.error, logContext, "reels.start", {
          platform_created_nothing: true,
        });
      }
      const videoId = start.data.video_id;

      // Hosted-file transfer: the bytes never pass through this process.
      try {
        await deps.graph.postAbsolute({
          url: start.data.upload_url ?? `${REELS_UPLOAD_BASE_URL}/${videoId}`,
          headers: {
            Authorization: `OAuth ${channel.accessToken}`,
            file_url: videoUrl,
          },
          context: { ...logContext, step: "reels.upload", video_id: videoId },
        });
      } catch (error) {
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "reels.upload",
          video_id: videoId,
          platform_created_nothing: true,
        });
      }

      // Only the finish phase publishes; start + upload created an unpublished
      // container. So this, and nothing before it, is `creating_post`.
      emitProgress(input.onProgress, log, { kind: "creating_post" });
      let finishRaw: Record<string, unknown>;
      try {
        finishRaw = await deps.graph.post({
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
      } catch (error) {
        // The publishing request is out. Same rule as /feed: unknown outcome.
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "reels.finish",
          video_id: videoId,
          feed_dispatched: true,
        });
      }
      const finish = ReelsFinishSchema.safeParse(finishRaw);
      if (!finish.success) {
        throw unusableResponse(finishRaw, finish.error, logContext, "reels.finish", {
          feed_dispatched: true,
        });
      }
      if (finish.data.success === false) {
        // An explicit "no" with a 200 body: never call that published — and
        // never call it "nothing was created" either. It answers the request
        // that publishes, which a previous attempt may already have completed.
        throw new AppError("META_ERROR", {
          message: "Reels finish phase reported success=false",
          userMessage: "Facebook không đăng được Reel này — xem nhật ký để biết chi tiết.",
          context: {
            ...logContext,
            step: "reels.finish",
            video_id: videoId,
            retryable: false,
            feed_dispatched: true,
          },
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
 *
 * WHERE `platform_created_nothing` MAY BE SET (port contract, and the reason
 * this adapter is split the way it is): only BEFORE the /feed request leaves
 * this process — the pre-flight guards, the album upload (photos are created
 * `published=false`, they are not posts) and the second lead check that runs
 * after the upload. Once /feed is dispatched the outcome belongs to the JOB, not
 * to this call: a previous attempt may have created the scheduled post and died
 * before the answer, and Facebook would then answer this attempt with #506
 * DUPLICATE_POST — an error body that means "a post like this already exists",
 * the exact opposite of "nothing was created". Errors from the dispatch carry
 * `feed_dispatched: true` instead, and the caller treats them as unknown.
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

      let mediaFbIds: string[];
      try {
        mediaFbIds = await uploadAlbumPhotos(
          deps,
          channel,
          media,
          { ...logContext, scheduled_publish_time: scheduledPublishTime },
          { onProgress: input.onProgress, log },
        );
      } catch (error) {
        // Nothing that creates a POST has been sent yet: these calls only make
        // UNPUBLISHED photo objects (`published=false`), and /feed below is what
        // turns them into something Facebook will publish. Whatever failed here
        // — Graph refusal, timeout, unreadable file — the Page holds no post for
        // this job, so the caller may still publish at the hour.
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "photos.album",
          platform_created_nothing: true,
        });
      }

      // The lead is measured AGAIN, right before the only call that creates
      // anything: an album of ten ~9MB photos can take minutes, and Facebook
      // refuses a `scheduled_publish_time` under ~10 minutes with #100. Catching
      // that here — BEFORE the request — is what lets the caller fall back to
      // publishing at the hour, because a refusal we never sent cannot have
      // created a post. After the dispatch we can no longer promise that.
      const leadAtDispatchMs = publishAt.getTime() - Date.now();
      if (leadAtDispatchMs < HANDOFF_MIN_LEAD_MS) {
        throw new AppError("INVALID_INPUT", {
          message: `Album upload consumed the lead: ${leadAtDispatchMs}ms left, ${HANDOFF_MIN_LEAD_MS}ms required`,
          userMessage:
            "Tải ảnh xong thì giờ hẹn đã quá gần (Facebook đòi tối thiểu ~10 phút) — không giao lịch, sẽ đăng thẳng vào giờ đã hẹn.",
          context: {
            ...logContext,
            step: "feed.scheduled",
            reason: "PUBLISH_AT_TOO_SOON_AFTER_UPLOAD",
            lead_ms: leadAtDispatchMs,
            min_lead_ms: HANDOFF_MIN_LEAD_MS,
            uploaded_media_count: mediaFbIds.length,
            retryable: false,
            platform_created_nothing: true,
          },
        });
      }

      const params: Record<string, string> = {
        message: caption,
        published: "false",
        scheduled_publish_time: String(scheduledPublishTime),
      };
      mediaFbIds.forEach((mediaFbId, index) => {
        params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: mediaFbId });
      });

      // The scheduled /feed creates the object Facebook will hold: same boundary
      // as an immediate publish, same single event, fired immediately before it.
      emitProgress(input.onProgress, log, { kind: "creating_post" });
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
        // The request that CREATES the post has left this process. NOTHING that
        // comes back is allowed to be reported as "the Page holds no post for
        // this job".
        //
        // A Graph error body proves that THIS request created nothing — but the
        // caller's question is about the JOB, not the request. An earlier
        // attempt of the same job may have dispatched a /feed whose answer never
        // arrived (timeout, killed worker) while Facebook committed the post;
        // the retry then re-uploads and Facebook answers #506 DUPLICATE_POST, an
        // error body that means the exact opposite of "nothing exists". Marking
        // it would send the job down the publish-at-the-hour path on top of a
        // scheduled post — two posts in the same minute (business rule 4).
        //
        // So: `feed_dispatched` only, and the caller must treat the outcome as
        // unknown. The refusal that this flow really needs to survive (#100 for
        // a lead the upload ate) is caught ABOVE, before the dispatch.
        throw AppError.from(error, "META_ERROR", {
          ...logContext,
          step: "feed.scheduled",
          scheduled_publish_time: scheduledPublishTime,
          feed_dispatched: true,
        });
      }
      const parsed = FeedResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw unusableResponse(raw, parsed.error, logContext, "feed.scheduled", {
          feed_dispatched: true,
        });
      }

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
      if (!parsed.success) {
        // A 200 whose body we cannot read is NOT a confirmation: Graph can
        // answer 200 with an envelope shape this client does not model, and
        // returning true here would tell the operator "Facebook sẽ không đăng
        // nữa" about a post the Page may still be holding.
        const appError = new AppError("META_ERROR", {
          message: "Graph answered the delete with a body that carries no confirmation",
          userMessage:
            "Facebook trả lời không rõ khi gỡ bài đã hẹn — hệ thống KHÔNG xác nhận được là bài đã bị gỡ. " +
            "Bài VẪN có thể còn trên Trang và tự đăng: hãy vào Trang, mục bài đã lên lịch, kiểm tra và xoá thủ công.",
          context: {
            ...logContext,
            step: "post.delete",
            reason: "UNCONFIRMED_DELETE_RESPONSE",
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
            response_keys: typeof raw === "object" && raw !== null ? Object.keys(raw) : null,
            retryable: false,
          },
        });
        log.error("Graph gave no readable confirmation for a scheduled post deletion", {
          err: appError,
          error_code: appError.code,
          reason: "UNCONFIRMED_DELETE_RESPONSE",
          alert: "OPERATOR_ATTENTION",
        });
        throw appError;
      }
      if (!parsed.data.success) {
        const appError = new AppError("META_ERROR", {
          message: "Graph answered success=false for a scheduled post deletion",
          userMessage:
            "Facebook không gỡ được bài đã hẹn — bài vẫn sẽ tự đăng, cần xoá trực tiếp trên Facebook.",
          context: {
            ...logContext,
            step: "post.delete",
            reason: "DELETE_REFUSED",
            retryable: false,
          },
        });
        log.error("Graph refused to delete a scheduled post", {
          err: appError,
          error_code: appError.code,
          reason: "DELETE_REFUSED",
          alert: "OPERATOR_ATTENTION",
        });
        throw appError;
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
  /** E7.5 — where the per-photo progress goes. Absent = the pre-E7.5 behaviour. */
  progress: { onProgress?: PublishProgressListener; log: Logger } = {
    log: deps.logger,
  },
): Promise<string[]> {
  const pageId = channel.externalId.trim();
  const mediaFbIds: string[] = [];
  const total = media.length;
  for (const [index, item] of media.entries()) {
    const fileName = typeof item?.fileName === "string" ? item.fileName : "";
    // Fired BEFORE the bytes are read: reading a 9 MB photo off Drive is part of
    // what the operator is waiting for, and a screen that only counts finished
    // photos sits on "2/10" while the third is being fetched.
    emitProgress(progress.onProgress, progress.log, {
      kind: "media_upload_started",
      index,
      total,
      fileName,
    });
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
      // `published=false`: whatever this answer was, it is not a post.
      throw unusableResponse(raw, parsed.error, logContext, `photos.album[${index}]`, {
        platform_created_nothing: true,
      });
    }
    mediaFbIds.push(parsed.data.id);
    emitProgress(progress.onProgress, progress.log, {
      kind: "media_upload_finished",
      index,
      total,
      fileName: file.fileName,
    });
  }
  return mediaFbIds;
}

/**
 * Hands ONE progress event to the caller's listener (port contract on
 * PublishProgressListener, design §5.5).
 *
 * The try/catch is the contract, not an oversight: a listener that throws is a
 * broken LISTENER, and a post that reached Facebook must not be reported as
 * failed because the screen's telemetry hiccupped. The failure is logged with
 * the event kind so it is still visible; nothing else in this adapter swallows
 * anything.
 */
function emitProgress(
  onProgress: PublishProgressListener | undefined,
  log: Logger,
  event: PublishProgressEvent,
): void {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(event);
  } catch (error) {
    log.warn("Progress listener threw — publishing continues", {
      err: AppError.from(error, "INTERNAL", { reason: "PROGRESS_LISTENER_FAILED" }),
      error_code: "INTERNAL",
      progress_kind: event.kind,
    });
  }
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
 * photos and a non-empty caption. Same error CODES the immediate path has always
 * raised, with two flags added to their context.
 *
 * These are THE pre-flight guards the scheduled path's contract names (see
 * makeFacebookScheduledPublisher): they run before a single byte leaves this
 * process, so every one of them carries `platform_created_nothing: true`. Left
 * off, the caller has to assume a scheduled post may exist and tells the
 * operator to go hunt for one on the Page — for a post that provably was never
 * sent anywhere, while dropping a job that could still have gone out at its
 * hour.
 *
 * `retryable: false` for the same reason in the other direction: no backoff
 * invents a caption, a Page id, or the 11th photo out of an album. It DOES
 * change the immediate path, deliberately: such a job now fails on attempt 1
 * instead of burning `maxAttempts` retries and the minutes between them on an
 * input that cannot become valid on its own.
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
        retryable: false,
        platform_created_nothing: true,
      },
    });
  }
  if (media.length === 0 || media.length > MAX_ALBUM_MEDIA) {
    throw new AppError("INVALID_INPUT", {
      message: `An album needs 1..${MAX_ALBUM_MEDIA} photos, got ${media.length}`,
      userMessage: `Bài ảnh phải có từ 1 đến ${MAX_ALBUM_MEDIA} ảnh.`,
      context: {
        tenant_id: input.tenantId,
        channel: channel.channelId,
        media_count: media.length,
        retryable: false,
        platform_created_nothing: true,
      },
    });
  }
  if (caption.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Refusing to publish a post without a caption",
      userMessage: "Bài đăng chưa có nội dung — không đăng.",
      context: {
        tenant_id: input.tenantId,
        channel: channel.channelId,
        retryable: false,
        platform_created_nothing: true,
      },
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
 *
 * Every error out of here carries `platform_created_nothing`: reading bytes
 * sends nothing to Facebook. It matters most on the SINGLE-photo path, where
 * this runs immediately before the one call that publishes — without the flag a
 * Drive hiccup would be read as "a post may exist" and stop the job for good.
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
        platform_created_nothing: true,
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
      platform_created_nothing: true,
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
        platform_created_nothing: true,
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
  /** Extra flags for the caller, e.g. that the creating request was dispatched. */
  extra: Record<string, unknown> = {},
): AppError {
  return new AppError("META_ERROR", {
    message: `Graph answered ${step} without a usable id`,
    userMessage:
      "Facebook không trả về mã bài đăng — cần kiểm tra thủ công trên Page trước khi đăng lại.",
    context: {
      ...context,
      ...extra,
      step,
      issues: error.issues.map((issue) => issue.path.join(".")),
      response_keys: typeof raw === "object" && raw !== null ? Object.keys(raw) : null,
      retryable: false,
    },
  });
}
