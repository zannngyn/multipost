"use client";

import { useId, useState } from "react";
import {
  Heart,
  MessageCircle,
  Bookmark,
  Share2,
  Music2,
  Search,
  Volume2,
  VolumeX,
  Play,
  RotateCw,
} from "lucide-react";

import { cn } from "@/shared/utils";
import { splitCaptionTags } from "@/ui/components/compose/caption-text";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset, VideoTarget } from "@/ui/schemas/compose.schema";
import { mediaPreviewUrl } from "@/ui/services/media-preview";

export interface UniversalLivePreviewProps {
  caption: string;
  channelName: string;
  channelPlatform?: "facebook" | "tiktok" | "instagram";
  videoTarget?: VideoTarget;
  media: readonly MediaAsset[];
  isVideo: boolean;
  className?: string;
}

const MOBILE_CUTOFF = 120;

export function UniversalLivePreview({
  caption,
  channelName,
  channelPlatform = "facebook",
  videoTarget = "facebook_video",
  media,
  isVideo,
  className,
}: UniversalLivePreviewProps) {
  const groupId = useId();
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [expanded, setExpanded] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

  const isReels = videoTarget === "facebook_reels" || channelPlatform === "tiktok";
  const { body, tags } = splitCaptionTags(caption);
  const text = body.trim();
  const isMobile = device === "mobile" || isReels;
  const isCut = !expanded && text.length > MOBILE_CUTOFF;

  const firstAsset = media[0];
  const firstVideoUrl =
    firstAsset && isVideo ? mediaPreviewUrl(firstAsset.driveFileId) : null;

  return (
    <aside
      aria-labelledby={`${groupId}-heading`}
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
    >
      <div
        className={cn(
          "border-border bg-card flex flex-col overflow-hidden rounded-2xl border shadow-sm transition-[max-width]",
          isReels ? "max-w-[340px] self-center" : isMobile ? "max-w-[380px] self-center" : "w-full",
        )}
      >
        {/* Chrome Bar */}
        <div className="border-border flex flex-wrap items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            <h2
              id={`${groupId}-heading`}
              className="text-muted-foreground font-mono text-[11px] font-semibold tracking-wider uppercase"
            >
              {isReels
                ? channelPlatform === "tiktok"
                  ? "TikTok Preview"
                  : "Facebook Reels Preview"
                : "Facebook Feed Preview"}
            </h2>
          </div>

          {!isReels && (
            <div
              role="group"
              aria-label="Khổ màn hình xem trước"
              className="bg-muted flex gap-1 rounded-lg p-1"
            >
              {(["desktop", "mobile"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={device === option}
                  onClick={() => setDevice(option)}
                  className={cn(
                    "cursor-pointer rounded-md px-2.5 py-1 text-xs font-semibold transition-all",
                    device === option
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option === "desktop" ? "Desktop" : "Mobile"}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* -------------------------------------------------------------
            REELS / TIKTOK VERTICAL 9:16 PREVIEW
            ------------------------------------------------------------- */}
        {isReels ? (
          <div className="relative aspect-[9/16] w-full overflow-hidden bg-black text-white select-none">
            {/* Background Media: Video Player or Image */}
            {isVideo && firstVideoUrl ? (
              <video
                src={firstVideoUrl}
                autoPlay
                loop
                muted={isMuted}
                playsInline
                className="h-full w-full object-cover"
              />
            ) : firstAsset ? (
              <div className="relative h-full w-full">
                <MediaThumb asset={firstAsset} alt="" lazy={false} />
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-500 text-xs">
                Chưa có video/ảnh
              </div>
            )}

            {/* Top Navigation Overlay */}
            <div className="absolute top-0 inset-x-0 flex items-center justify-between p-4 bg-gradient-to-b from-black/60 to-transparent">
              <div className="flex items-center gap-3 text-xs font-bold">
                <span className="opacity-60 hover:opacity-100 cursor-pointer">Đang follow</span>
                <span className="border-b-2 border-white pb-0.5">Dành cho bạn</span>
              </div>
              <div className="flex items-center gap-2">
                {isVideo && (
                  <button
                    type="button"
                    onClick={() => setIsMuted(!isMuted)}
                    className="p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60 backdrop-blur-xs"
                  >
                    {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                  </button>
                )}
                <Search className="size-4" />
              </div>
            </div>

            {/* Right Action Rail */}
            <div className="absolute right-3 bottom-16 flex flex-col items-center gap-4">
              <div className="relative">
                <div className="flex size-10 items-center justify-center rounded-full border-2 border-white bg-primary text-xs font-bold text-primary-foreground">
                  {channelName.slice(0, 2).toUpperCase() || "MY"}
                </div>
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-black leading-none">
                  +
                </span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="flex size-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-xs">
                  <Heart className="size-5 fill-white text-white" />
                </div>
                <span className="text-[10px] font-semibold">12.8K</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="flex size-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-xs">
                  <MessageCircle className="size-5" />
                </div>
                <span className="text-[10px] font-semibold">342</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="flex size-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-xs">
                  <Bookmark className="size-5" />
                </div>
                <span className="text-[10px] font-semibold">890</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div className="flex size-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-xs">
                  <Share2 className="size-5" />
                </div>
                <span className="text-[10px] font-semibold">154</span>
              </div>

              <div className="mt-1 flex size-9 items-center justify-center rounded-full border-2 border-zinc-800 bg-zinc-900 animate-spin">
                <Music2 className="size-4 text-zinc-400" />
              </div>
            </div>

            {/* Bottom Caption Overlay */}
            <div className="absolute inset-x-0 bottom-0 p-4 pt-12 bg-gradient-to-t from-black/90 via-black/40 to-transparent">
              <p className="text-sm font-bold tracking-tight">
                @{channelName ? channelName.toLowerCase().replace(/\s+/g, "_") : "mysp_fashion"}
              </p>
              <div className="mt-1 text-xs leading-relaxed text-zinc-100">
                {text.length === 0 ? (
                  <span className="text-zinc-400 italic">Chưa có caption...</span>
                ) : isCut ? (
                  <span>
                    {text.slice(0, MOBILE_CUTOFF)}…{" "}
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      className="font-bold underline text-white"
                    >
                      thêm
                    </button>
                  </span>
                ) : (
                  <span>{text}</span>
                )}
              </div>
              {tags.length > 0 && (
                <p className="mt-1 text-xs font-semibold text-sky-400">{tags}</p>
              )}
              <div className="mt-2.5 flex items-center gap-2 text-[11px] text-zinc-300">
                <Music2 className="size-3.5 shrink-0" />
                <span className="truncate">Nhạc nền thịnh hành — MYSP Studio Sound</span>
              </div>
            </div>
          </div>
        ) : (
          /* -------------------------------------------------------------
              FACEBOOK FEED POST PREVIEW (ALBUM / 16:9 VIDEO)
              ------------------------------------------------------------- */
          <div className="flex flex-col bg-card text-foreground">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[13px] font-bold text-primary"
              >
                {channelName ? channelName.slice(0, 2).toUpperCase() : "FB"}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-bold leading-tight">{channelName || "Page Facebook của bạn"}</span>
                <span className="text-[11px] text-muted-foreground">Vừa xong · Công khai 🌐</span>
              </div>
            </div>

            {/* Caption */}
            <div className="px-4 pb-3 text-sm leading-relaxed">
              {text.length === 0 ? (
                <p className="text-muted-foreground italic">
                  Chưa có caption — bài chưa đăng được.
                </p>
              ) : isCut ? (
                <p className="whitespace-pre-wrap">
                  {text.slice(0, MOBILE_CUTOFF)}…{" "}
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="font-semibold text-primary underline"
                  >
                    Xem thêm
                  </button>
                </p>
              ) : (
                <p className="whitespace-pre-wrap">{text}</p>
              )}
            </div>

            {tags.length > 0 && (
              <div className="px-4 pb-3 text-sm break-words text-primary font-medium">{tags}</div>
            )}

            {/* Media Rendering */}
            {isVideo && firstVideoUrl ? (
              <div className="relative aspect-video w-full overflow-hidden bg-black">
                <video
                  src={firstVideoUrl}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <FacebookCollage media={media} compact={isMobile} />
            )}

            {/* Social Action Footer */}
            <div className="flex h-11 items-center border-t border-border px-2 text-xs font-semibold text-muted-foreground">
              {["👍 Thích", "💬 Bình luận", "↗️ Chia sẻ"].map((action) => (
                <button
                  key={action}
                  type="button"
                  className="flex-1 py-2 text-center hover:bg-muted/50 rounded-lg transition-colors"
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-center text-muted-foreground">
        Xem trước mô phỏng giao diện khi hiển thị trên {isReels ? "Reels / TikTok" : "bảng tin Facebook"}.
      </p>
    </aside>
  );
}

function FacebookCollage({
  media,
  compact,
}: {
  media: readonly MediaAsset[];
  compact: boolean;
}) {
  if (media.length === 0) {
    return (
      <div className="flex aspect-video w-full items-center justify-center bg-muted text-xs text-muted-foreground">
        Chưa có ảnh trong bài
      </div>
    );
  }

  if (media.length === 1) {
    return (
      <div className="relative aspect-square w-full bg-muted overflow-hidden">
        <MediaThumb asset={media[0]} alt="" lazy={false} />
      </div>
    );
  }

  const left = media.slice(0, 2);
  const right = media.slice(2, 5);
  const overflow = Math.max(0, media.length - left.length - right.length);
  const tileHeight = compact ? "h-40" : "h-52";

  return (
    <div className="grid grid-cols-[1.55fr_1fr] gap-1 bg-border p-0.5">
      <div className="flex flex-col gap-1">
        {left.map((asset, index) => (
          <div key={`${asset.driveFileId}-${index}`} className={cn("relative bg-muted", tileHeight)}>
            <MediaThumb asset={asset} alt="" lazy={index > 0} />
          </div>
        ))}
      </div>

      {right.length > 0 && (
        <div className="flex flex-col gap-1">
          {right.map((asset, index) => (
            <div
              key={`${asset.driveFileId}-${index}`}
              className="relative min-h-20 flex-1 bg-muted overflow-hidden"
            >
              <MediaThumb asset={asset} alt="" />
              {overflow > 0 && index === right.length - 1 && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-lg font-bold text-white">
                  +{overflow}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
