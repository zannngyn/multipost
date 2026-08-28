"use client";

import { useState } from "react";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset } from "@/ui/schemas/compose.schema";
import { mediaPreviewUrl } from "@/ui/services/media-preview";

export interface FacebookPreviewProps {
  channelName: string;
  avatarUrl?: string;
  caption: string;
  media: readonly MediaAsset[];
  isVideo: boolean;
  isReels?: boolean;
}

const FBReactionIcons = () => (
  <svg
    width="31"
    height="16"
    viewBox="0 0 31 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="shrink-0"
  >
    <path
      d="M8 0C5.87827 0 3.84344 0.842855 2.34315 2.34315C0.842855 3.84344 0 5.87827 0 8C0 10.1217 0.842855 12.1566 2.34315 13.6569C3.84344 15.1571 5.87827 16 8 16C10.1217 16 12.1566 15.1571 13.6569 13.6569C15.1571 12.1566 16 10.1217 16 8C16 5.87827 15.1571 3.84344 13.6569 2.34315C12.1566 0.842855 10.1217 0 8 0Z"
      fill="url(#fb_like_gradient)"
    />
    <path
      d="M12.162 7.338C12.338 7.461 12.5 7.583 12.5 8.012C12.5 8.442 12.271 8.616 12.026 8.737C12.1262 8.90028 12.1581 9.09637 12.115 9.283C12.038 9.627 11.723 9.894 11.443 9.973C11.564 10.167 11.602 10.358 11.458 10.593C11.273 10.888 11.112 11 10.4 11H7.5C6.512 11 6 10.454 6 10V7.665C6 6.435 7.467 5.39 7.467 4.535L7.361 3.47C7.356 3.405 7.369 3.246 7.419 3.2C7.499 3.121 7.72 3 8.054 3C8.272 3 8.417 3.041 8.588 3.123C9.169 3.4 9.32 4.101 9.32 4.665C9.32 4.936 8.906 5.748 8.85 6.029C8.85 6.029 9.717 5.837 10.729 5.83C11.79 5.824 12.478 6.02 12.478 6.672C12.478 6.933 12.259 7.195 12.162 7.338ZM3.6 7H4.4C4.55913 7 4.71174 7.06321 4.82426 7.17574C4.93679 7.28826 5 7.44087 5 7.6V11.4C5 11.5591 4.93679 11.7117 4.82426 11.8243C4.71174 11.9368 4.55913 12 4.4 12H3.6C3.44087 12 3.28826 11.9368 3.17574 11.8243C3.06321 11.7117 3 11.5591 3 11.4V7.6C3 7.44087 3.06321 7.28826 3.17574 7.17574C3.28826 7.06321 3.44087 7 3.6 7Z"
      fill="white"
    />
    <path
      d="M23 0C20.8783 0 18.8434 0.842855 17.3431 2.34315C15.8429 3.84344 15 5.87827 15 8C15 10.1217 15.8429 12.1566 17.3431 13.6569C18.8434 15.1571 20.8783 16 23 16C25.1217 16 27.1566 15.1571 28.6569 13.6569C30.1571 12.1566 31 10.1217 31 8C31 5.87827 30.1571 3.84344 28.6569 2.34315C27.1566 0.842855 25.1217 0 23 0Z"
      fill="url(#fb_heart_gradient)"
    />
    <path
      d="M25.473 4C23.275 4 23 5.824 23 5.824C23 5.824 22.726 4 20.528 4C18.414 4 17.798 6.222 18.056 7.41C18.736 10.55 23 12.75 23 12.75C23 12.75 27.265 10.55 27.945 7.41C28.202 6.222 27.585 4 25.473 4Z"
      fill="white"
    />
    <defs>
      <linearGradient
        id="fb_like_gradient"
        x1="8"
        y1="0"
        x2="8"
        y2="16"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#18AFFF" />
        <stop offset="1" stopColor="#0062DF" />
      </linearGradient>
      <linearGradient
        id="fb_heart_gradient"
        x1="23"
        y1="0"
        x2="23"
        y2="16"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#FF6680" />
        <stop offset="1" stopColor="#E61739" />
      </linearGradient>
    </defs>
  </svg>
);

const GlobeIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M5 10C4.30833 10 3.65833 9.86867 3.05 9.606C2.44167 9.34367 1.9125 8.9875 1.4625 8.5375C1.0125 8.0875 0.656333 7.55833 0.394 6.95C0.131333 6.34167 0 5.69167 0 5C0 4.30833 0.131333 3.65833 0.394 3.05C0.656333 2.44167 1.0125 1.9125 1.4625 1.4625C1.9125 1.0125 2.44167 0.656167 3.05 0.3935C3.65833 0.131167 4.30833 0 5 0C5.69167 0 6.34167 0.131167 6.95 0.3935C7.55833 0.656167 8.0875 1.0125 8.5375 1.4625C8.9875 1.9125 9.34367 2.44167 9.606 3.05C9.86867 3.65833 10 4.30833 10 5C10 5.69167 9.86867 6.34167 9.606 6.95C9.34367 7.55833 8.9875 8.0875 8.5375 8.5375C8.0875 8.9875 7.55833 9.34367 6.95 9.606C6.34167 9.86867 5.69167 10 5 10ZM4.5 8.975V8C4.225 8 3.98967 7.90217 3.794 7.7065C3.598 7.5105 3.5 7.275 3.5 7V6.5L1.1 4.1C1.075 4.25 1.052 4.4 1.031 4.55C1.01033 4.7 1 4.85 1 5C1 6.00833 1.33133 6.89167 1.994 7.65C2.65633 8.40833 3.49167 8.85 4.5 8.975ZM7.95 7.7C8.11667 7.51667 8.26667 7.31867 8.4 7.106C8.53333 6.89367 8.64383 6.67283 8.7315 6.4435C8.81883 6.2145 8.8855 5.97917 8.9315 5.7375C8.97717 5.49583 9 5.25 9 5C9 4.18333 8.773 3.4375 8.319 2.7625C7.86467 2.0875 7.25833 1.6 6.5 1.3V1.5C6.5 1.775 6.40217 2.01033 6.2065 2.206C6.0105 2.402 5.775 2.5 5.5 2.5H4.5V3.5C4.5 3.64167 4.45217 3.76033 4.3565 3.856C4.2605 3.952 4.14167 4 4 4H3V5H6C6.14167 5 6.2605 5.04783 6.3565 5.1435C6.45217 5.2395 6.5 5.35833 6.5 5.5V7H7C7.21667 7 7.4125 7.0645 7.5875 7.1935C7.7625 7.32283 7.88333 7.49167 7.95 7.7Z"
      fill="currentColor"
    />
  </svg>
);

export function FacebookPreview({
  channelName,
  avatarUrl,
  caption,
  media,
  isVideo,
}: FacebookPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const cutoff = 160;
  const isCut = !expanded && caption.trim().length > cutoff;

  const firstAsset = media[0];
  const firstVideoUrl = firstAsset && isVideo ? mediaPreviewUrl(firstAsset.driveFileId) : null;

  return (
    <div className="flex flex-col bg-card rounded-2xl border border-border overflow-hidden shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#1877F2]/10 text-xs font-bold text-[#1877F2]">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" />
          ) : (
            channelName.slice(0, 2).toUpperCase() || "FB"
          )}
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[13px] font-bold text-foreground truncate">
            {channelName || "Page Facebook của bạn"}
          </span>
          <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
            <span>Vừa xong •</span>
            <GlobeIcon />
          </div>
        </div>
      </div>

      {/* Caption Text */}
      <div className="px-4 py-3 text-[13px] leading-relaxed text-foreground whitespace-pre-line">
        {caption.trim().length === 0 ? (
          <span className="text-muted-foreground italic">Chưa có nội dung bài viết...</span>
        ) : isCut ? (
          <span>
            {caption.trim().slice(0, cutoff)}…{" "}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="font-bold text-primary hover:underline cursor-pointer"
            >
              Xem thêm
            </button>
          </span>
        ) : (
          <span>{caption.trim()}</span>
        )}
      </div>

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
      ) : media.length === 0 ? (
        <div className="flex aspect-video w-full items-center justify-center bg-muted/60 text-xs text-muted-foreground">
          Chưa có hình ảnh/video đính kèm
        </div>
      ) : media.length === 1 ? (
        <div className="relative aspect-square w-full bg-muted overflow-hidden">
          <MediaThumb asset={media[0]} alt="" lazy={false} />
        </div>
      ) : (
        /* Postiz Style Facebook Multi-image Collage */
        <div className="grid grid-cols-[1.5fr_1fr] gap-1 bg-border/80 p-0.5">
          <div className="flex flex-col gap-1">
            {media.slice(0, 2).map((asset, i) => (
              <div key={`${asset.driveFileId}-${i}`} className="relative h-44 bg-muted overflow-hidden">
                <MediaThumb asset={asset} alt="" lazy={i > 0} />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {media.slice(2, 5).map((asset, i) => {
              const overflow = Math.max(0, media.length - 5);
              const isLast = i === media.slice(2, 5).length - 1;
              return (
                <div key={`${asset.driveFileId}-${i}`} className="relative flex-1 min-h-20 bg-muted overflow-hidden">
                  <MediaThumb asset={asset} alt="" />
                  {overflow > 0 && isLast && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-base font-bold text-white">
                      +{overflow}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Postiz Social Reactions Row */}
      <div className="flex items-center justify-between px-4 py-2 text-[11px] text-muted-foreground border-t border-border/40">
        <div className="flex items-center gap-2">
          <FBReactionIcons />
          <span>Bạn và 18 người khác</span>
        </div>
        <div>5 bình luận • 2 lượt chia sẻ</div>
      </div>

      {/* Postiz Social Action Buttons */}
      <div className="flex items-center justify-between border-t border-border px-2 py-1 text-xs font-semibold text-muted-foreground">
        <button
          type="button"
          className="flex-1 py-1.5 flex items-center justify-center gap-1.5 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
          <span>Thích</span>
        </button>

        <button
          type="button"
          className="flex-1 py-1.5 flex items-center justify-center gap-1.5 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Bình luận</span>
        </button>

        <button
          type="button"
          className="flex-1 py-1.5 flex items-center justify-center gap-1.5 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          <span>Chia sẻ</span>
        </button>
      </div>
    </div>
  );
}
