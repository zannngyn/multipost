"use client";

import { type FC, type ReactNode } from "react";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset } from "@/ui/schemas/compose.schema";
import { mediaPreviewUrl } from "@/ui/services/media-preview";

export interface TikTokPreviewProps {
  channelName: string;
  avatarUrl?: string;
  caption: string;
  media: readonly MediaAsset[];
  isVideo: boolean;
}

const TikTokItem: FC<{ icon: ReactNode; num: string }> = ({ icon, num }) => (
  <div className="flex items-center flex-col gap-0.5">
    <div className="size-9 rounded-full bg-black/50 backdrop-blur-xs flex justify-center items-center text-white">
      {icon}
    </div>
    <div className="text-[10px] font-bold text-white shadow-xs">{num}</div>
  </div>
);

export function TikTokPreview({
  channelName,
  avatarUrl,
  caption,
  media,
  isVideo,
}: TikTokPreviewProps) {
  const firstAsset = media[0];
  const firstVideoUrl = firstAsset && isVideo ? mediaPreviewUrl(firstAsset.driveFileId) : null;
  const username = channelName ? channelName.toLowerCase().replace(/\s+/g, "_") : "mysp_fashion";

  return (
    <div className="relative aspect-[9/16] w-full max-w-[340px] mx-auto overflow-hidden rounded-2xl bg-black text-white select-none border border-border shadow-md">
      {/* Background Media */}
      {isVideo && firstVideoUrl ? (
        <video
          src={firstVideoUrl}
          autoPlay
          loop
          muted
          playsInline
          className="size-full object-cover"
        />
      ) : firstAsset ? (
        <div className="relative size-full">
          <MediaThumb asset={firstAsset} alt="" lazy={false} />
        </div>
      ) : (
        <div className="flex size-full items-center justify-center bg-zinc-900 text-zinc-500 text-xs">
          Chưa có video/ảnh TikTok
        </div>
      )}

      {/* Top Navigation */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between p-3.5 bg-gradient-to-b from-black/70 to-transparent z-10">
        <div className="flex items-center gap-3 text-xs font-bold">
          <span className="opacity-60 hover:opacity-100 cursor-pointer">Đang follow</span>
          <span className="border-b-2 border-white pb-0.5">Dành cho bạn</span>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>

      {/* Right Action Rail - Exact Postiz SVGs */}
      <div className="absolute right-3 bottom-14 flex flex-col items-center gap-3 z-10">
        {/* Avatar with red plus */}
        <div className="relative mb-1">
          <div className="size-9 rounded-full border-2 border-white bg-zinc-800 flex items-center justify-center text-xs font-bold overflow-hidden">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              channelName.slice(0, 2).toUpperCase() || "TT"
            )}
          </div>
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-1 size-3.5 rounded-full bg-[#EA4359] flex items-center justify-center text-[9px] font-black text-white leading-none">
            +
          </div>
        </div>

        {/* Heart */}
        <TikTokItem
          num="1.3M"
          icon={
            <svg width="16" height="15" viewBox="0 0 14 13" fill="none">
              <path
                d="M6.73271 12.3432C6.54684 12.3432 6.36164 12.274 6.20938 12.1348C5.66959 11.6478 5.14626 11.1786 4.67368 10.7786C3.32385 9.57933 2.14275 8.55317 1.33269 7.54467C0.421822 6.41466 0 5.33697 0 4.17236C0 3.02468 0.371068 1.98152 1.06313 1.21694C1.75518 0.434621 2.7168 0 3.76278 0C4.53921 0 5.24773 0.260773 5.87189 0.747687C6.19221 1.00846 6.47958 1.30386 6.73268 1.66922C6.98577 1.30386 7.27247 1.00846 7.59346 0.747687C8.21762 0.243805 8.92615 0 9.70257 0C10.7486 0 11.6937 0.434621 12.4022 1.21694C13.0943 1.98159 13.4654 3.04235 13.4654 4.17236C13.4654 5.35467 13.0435 6.41466 12.1327 7.54467C11.3226 8.55313 10.1415 9.57853 8.79167 10.7786C8.33624 11.1786 7.79644 11.6478 7.25597 12.1348C7.10372 12.274 6.91852 12.3432 6.73264 12.3432H6.73271Z"
                fill="currentColor"
              />
            </svg>
          }
        />

        {/* Comment */}
        <TikTokItem
          num="10.7K"
          icon={
            <svg width="16" height="15" viewBox="0 0 15 14" fill="none">
              <path
                d="M7.03906 0C10.9263 0.000164123 14.0771 2.70127 14.0771 6.0332C14.0771 6.9371 13.8434 7.79378 13.4277 8.56348C13.4272 8.56492 13.4274 8.56696 13.4268 8.56836C12.6717 10.1862 11.4147 11.5178 9.84277 12.3643L8.0918 13.3076C7.64292 13.5491 7.10605 13.1896 7.1582 12.6826L7.22168 12.0615C7.16098 12.0629 7.10014 12.0664 7.03906 12.0664C3.15189 12.0664 0.000323506 9.365 0 6.0332C0 2.70117 3.15169 0 7.03906 0ZM3.41895 5.22852C2.86382 5.22876 2.41406 5.67919 2.41406 6.23438C2.41423 6.78942 2.86392 7.23901 3.41895 7.23926C3.97418 7.23926 4.42464 6.78957 4.4248 6.23438C4.4248 5.67904 3.97428 5.22852 3.41895 5.22852ZM7.03711 5.22852C6.48177 5.22852 6.03125 5.67904 6.03125 6.23438C6.03143 6.78956 6.48188 7.23926 7.03711 7.23926C7.59219 7.23908 8.04181 6.78945 8.04199 6.23438C8.04199 5.67915 7.5923 5.22869 7.03711 5.22852ZM10.6582 5.22852C10.1029 5.22852 9.65234 5.67904 9.65234 6.23438C9.65251 6.78957 10.103 7.23926 10.6582 7.23926C11.2133 7.23914 11.6629 6.7895 11.6631 6.23438C11.6631 5.67911 11.2134 5.22864 10.6582 5.22852Z"
                fill="currentColor"
              />
            </svg>
          }
        />

        {/* Bookmark */}
        <TikTokItem
          num="1.2K"
          icon={
            <svg width="14" height="15" viewBox="0 0 11 12" fill="none">
              <path
                d="M8.09766 0C9.37507 0.000192409 10.4129 1.04397 10.4189 2.31543V10.7666C10.4189 11.852 9.6448 12.3079 8.69727 11.7803L5.77051 10.1543C5.46465 9.98038 4.96034 9.98042 4.64844 10.1543L1.72168 11.7803C0.77405 12.3021 8.98228e-05 11.8461 0 10.7666V2.31543C0 1.04385 1.03786 0 2.31543 0H8.09766Z"
                fill="currentColor"
              />
            </svg>
          }
        />

        {/* Share */}
        <TikTokItem
          num="340"
          icon={
            <svg width="15" height="14" viewBox="0 0 14 13" fill="none">
              <path
                d="M13.8049 6.13627L8.62939 0.722602C8.3615 0.442387 7.91578 0.632128 7.91578 1.02131V3.70202C3.12574 3.79156 0 5.48512 0 11.1963C0 11.7778 0.638421 12.1158 1.08779 11.7456C3.1365 10.0573 5.44185 9.20815 7.91578 9.20815V11.9786C7.91578 12.3678 8.3615 12.5576 8.62939 12.2773L13.8049 6.8637C14.0048 6.65457 14.0048 6.3454 13.8049 6.13627Z"
                fill="currentColor"
              />
            </svg>
          }
        />

        {/* Spinning Music Disk */}
        <div className="size-8 rounded-full border-2 border-zinc-800 bg-zinc-900 flex items-center justify-center animate-spin mt-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </div>
      </div>

      {/* Bottom Caption Overlay */}
      <div className="absolute inset-x-0 bottom-0 p-3.5 pt-12 bg-gradient-to-t from-black/95 via-black/50 to-transparent z-10 pr-16">
        <div className="text-sm font-bold tracking-tight">@{username}</div>
        <div className="mt-1 text-xs leading-relaxed text-zinc-100 whitespace-pre-line line-clamp-4">
          {caption.trim() || <span className="text-zinc-400 italic">Chưa có nội dung TikTok...</span>}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-300">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span className="truncate">Âm thanh gốc — {channelName || "MYSP"}</span>
        </div>
      </div>
    </div>
  );
}
