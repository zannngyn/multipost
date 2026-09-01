"use client";

import { useState } from "react";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset } from "@/ui/schemas/compose.schema";
import { mediaPreviewUrl } from "@/ui/services/media-preview";

export interface InstagramPreviewProps {
  channelName: string;
  avatarUrl?: string;
  caption: string;
  media: readonly MediaAsset[];
  isVideo: boolean;
}

export function InstagramPreview({
  channelName,
  avatarUrl,
  caption,
  media,
  isVideo,
}: InstagramPreviewProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const firstAsset = media[0];
  const firstVideoUrl = firstAsset && isVideo ? mediaPreviewUrl(firstAsset.driveFileId) : null;
  const username = channelName ? channelName.toLowerCase().replace(/\s+/g, "_") : "mysp_fashion";

  return (
    <div className="flex flex-col bg-card rounded-2xl border border-border overflow-hidden shadow-xs">
      {/* IG Header */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          {/* Gradient Ring Avatar */}
          <div className="p-0.5 rounded-full bg-gradient-to-tr from-[#FCAF45] via-[#FF543E] to-[#C13584]">
            <div className="size-8 rounded-full bg-background flex items-center justify-center text-xs font-bold text-foreground overflow-hidden">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                channelName.slice(0, 2).toUpperCase() || "IG"
              )}
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-[13px] font-bold text-foreground leading-tight">
              {username}
            </span>
            <span className="text-[10px] text-muted-foreground">Original audio</span>
          </div>
        </div>

        {/* More dots */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
          <circle cx="5" cy="12" r="1" />
        </svg>
      </div>

      {/* Media Rendering */}
      {isVideo && firstVideoUrl ? (
        <div className="relative aspect-square w-full overflow-hidden bg-black">
          <video
            src={firstVideoUrl}
            controls
            playsInline
            className="size-full object-cover"
          />
        </div>
      ) : media.length === 0 ? (
        <div className="flex aspect-square w-full items-center justify-center bg-muted text-xs text-muted-foreground">
          Chưa có hình ảnh Instagram
        </div>
      ) : (
        <div className="relative aspect-square w-full bg-muted overflow-hidden">
          <MediaThumb asset={media[currentSlide] ?? media[0]} alt="" lazy={false} />
          {media.length > 1 && (
            <div className="absolute top-2.5 right-2.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-xs">
              {currentSlide + 1}/{media.length}
            </div>
          )}

          {/* Slider Prev / Next Controls if multi-image */}
          {media.length > 1 && (
            <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 flex items-center justify-between pointer-events-none">
              <button
                type="button"
                onClick={() => setCurrentSlide((prev) => (prev > 0 ? prev - 1 : media.length - 1))}
                className="size-7 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center pointer-events-auto backdrop-blur-xs cursor-pointer"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => setCurrentSlide((prev) => (prev < media.length - 1 ? prev + 1 : 0))}
                className="size-7 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center pointer-events-auto backdrop-blur-xs cursor-pointer"
              >
                ›
              </button>
            </div>
          )}
        </div>
      )}

      {/* IG Action Bar - Exact Postiz SVGs */}
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <div className="flex items-center gap-3.5">
          {/* Heart */}
          <svg width="22" height="20" viewBox="0 0 22 20" fill="none" className="cursor-pointer hover:text-red-500 transition-colors">
            <path
              d="M10.7232 18.2722C10.7232 18.2722 0.792969 12.7112 0.792969 5.95866C0.792969 4.76493 1.20656 3.60807 1.96337 2.68491C2.72018 1.76175 3.77346 1.12932 4.94401 0.895206C6.11455 0.661097 7.33006 0.839776 8.38371 1.40084C9.43737 1.96191 10.2641 2.87071 10.7232 3.97261V3.97261C11.1823 2.87071 12.0091 1.96191 13.0627 1.40084C14.1164 0.839776 15.3319 0.661097 16.5024 0.895206C17.673 1.12932 18.7263 1.76175 19.4831 2.68491C20.2399 3.60807 20.6535 4.76493 20.6535 5.95866C20.6535 12.7112 10.7232 18.2722 10.7232 18.2722Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          {/* Comment */}
          <svg width="22" height="22" viewBox="0 0 26 26" fill="none" className="cursor-pointer">
            <path
              d="M4.5067 17.576C3.3239 15.5805 2.91017 13.2218 3.34318 10.9428C3.7762 8.66377 5.02618 6.6212 6.85846 5.1985C8.69075 3.7758 10.9793 3.07083 13.2946 3.21592C15.6098 3.36102 17.7924 4.34621 19.4328 5.98653C21.0731 7.62686 22.0583 9.80951 22.2034 12.1247C22.3485 14.44 21.6435 16.7285 20.2208 18.5608C18.7981 20.3931 16.7555 21.6431 14.4765 22.0761C12.1975 22.5091 9.83884 22.0954 7.84327 20.9126V20.9126L4.54642 21.846C4.41135 21.8855 4.26814 21.888 4.13179 21.8531C3.99545 21.8182 3.871 21.7473 3.77149 21.6478C3.67197 21.5483 3.60106 21.4238 3.56619 21.2875C3.53131 21.1512 3.53375 21.0079 3.57326 20.8729L4.5067 17.576Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          {/* Send */}
          <svg width="22" height="22" viewBox="0 0 26 26" fill="none" className="cursor-pointer">
            <path
              d="M20.884 3.56475L2.37397 8.77813C2.21641 8.82121 2.07595 8.91181 1.97174 9.0376C1.86752 9.16339 1.80462 9.31824 1.79159 9.48107C1.77857 9.6439 1.81605 9.80679 1.89894 9.94754C1.98183 10.0883 2.1061 10.2001 2.25481 10.2677L10.7551 14.2894C10.9216 14.3665 11.0553 14.5003 11.1325 14.6668L15.1542 23.1671C15.2218 23.3158 15.3336 23.44 15.4743 23.5229C15.6151 23.6058 15.778 23.6433 15.9408 23.6303C16.1036 23.6172 16.2585 23.5543 16.3843 23.4501C16.5101 23.3459 16.6007 23.2055 16.6437 23.0479L21.8571 4.53791C21.8966 4.40284 21.8991 4.25962 21.8642 4.12328C21.8293 3.98694 21.7584 3.86249 21.6589 3.76297C21.5594 3.66346 21.4349 3.59255 21.2986 3.55767C21.1622 3.5228 21.019 3.52524 20.884 3.56475V3.56475Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Bookmark */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="cursor-pointer">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </div>

      {/* Likes */}
      <div className="px-3.5 text-xs font-bold text-foreground">
        128 lượt thích
      </div>

      {/* Caption with bold username */}
      <div className="px-3.5 py-2 text-xs leading-relaxed text-foreground">
        <strong className="font-bold text-foreground mr-1.5">{username}</strong>
        <span className="whitespace-pre-line">{caption.trim() || <span className="text-muted-foreground italic">Chưa có caption...</span>}</span>
        <p className="mt-1.5 text-[11px] text-muted-foreground cursor-pointer">
          Xem tất cả 12 bình luận
        </p>
        <p className="text-[10px] text-muted-foreground uppercase mt-1 tracking-wider">
          Vừa xong
        </p>
      </div>
    </div>
  );
}
