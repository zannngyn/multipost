"use client";

import { useId, useState } from "react";
import { cn } from "@/shared/utils";
import type { MediaAsset, VideoTarget } from "@/ui/schemas/compose.schema";
import { FacebookPreview } from "@/ui/components/compose/previews/FacebookPreview";
import { TikTokPreview } from "@/ui/components/compose/previews/TikTokPreview";
import { InstagramPreview } from "@/ui/components/compose/previews/InstagramPreview";

export type PreviewPlatform = "facebook" | "tiktok" | "instagram";

export interface UniversalLivePreviewProps {
  caption: string;
  channelName: string;
  channelPlatform?: "facebook" | "tiktok";
  avatarUrl?: string;
  videoTarget?: VideoTarget;
  media: readonly MediaAsset[];
  isVideo: boolean;
  className?: string;
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-3.5", className)}>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-3.5", className)}>
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("size-3.5", className)}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

export function UniversalLivePreview({
  caption,
  channelName,
  channelPlatform = "facebook",
  avatarUrl,
  videoTarget = "facebook_video",
  media,
  isVideo,
  className,
}: UniversalLivePreviewProps) {
  const groupId = useId();
  const [userPlatformOverride, setUserPlatformOverride] = useState<PreviewPlatform | null>(null);
  const activePlatform: PreviewPlatform =
    userPlatformOverride ?? (channelPlatform === "tiktok" ? "tiktok" : "facebook");

  return (
    <aside
      aria-labelledby={`${groupId}-heading`}
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
    >
      {/* Platform Switcher Tabs (Postiz Style Navigation with Brand SVGs) */}
      <div className="flex items-center justify-between bg-card border border-border/80 rounded-xl p-1.5 shadow-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setUserPlatformOverride("facebook")}
            className={cn(
              "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all flex items-center gap-1.5",
              activePlatform === "facebook"
                ? "bg-[#1877F2]/10 text-[#1877F2] ring-1 ring-[#1877F2]/30 shadow-xs"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <FacebookIcon className="text-[#1877F2]" />
            <span>Facebook</span>
          </button>

          <button
            type="button"
            onClick={() => setUserPlatformOverride("tiktok")}
            className={cn(
              "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all flex items-center gap-1.5",
              activePlatform === "tiktok"
                ? "bg-foreground/10 text-foreground ring-1 ring-foreground/30 shadow-xs"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <TikTokIcon className="text-black dark:text-white" />
            <span>TikTok</span>
          </button>

          <button
            type="button"
            onClick={() => setUserPlatformOverride("instagram")}
            className={cn(
              "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all flex items-center gap-1.5",
              activePlatform === "instagram"
                ? "bg-[#E1306C]/10 text-[#E1306C] ring-1 ring-[#E1306C]/30 shadow-xs"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <InstagramIcon className="text-[#E1306C]" />
            <span>Instagram</span>
          </button>
        </div>
      </div>

      {/* Platform-Specific Preview Renderers (Directly from Postiz structure) */}
      <div className="w-full">
        {activePlatform === "facebook" && (
          <FacebookPreview
            channelName={channelName}
            avatarUrl={avatarUrl}
            caption={caption}
            media={media}
            isVideo={isVideo}
            isReels={videoTarget === "facebook_reels"}
          />
        )}

        {activePlatform === "tiktok" && (
          <TikTokPreview
            channelName={channelName}
            avatarUrl={avatarUrl}
            caption={caption}
            media={media}
            isVideo={isVideo}
          />
        )}

        {activePlatform === "instagram" && (
          <InstagramPreview
            channelName={channelName}
            avatarUrl={avatarUrl}
            caption={caption}
            media={media}
            isVideo={isVideo}
          />
        )}
      </div>

      <p className="text-[11px] text-center text-muted-foreground">
        Xem trước mô phỏng giao diện hiển thị trên {activePlatform === "facebook" ? "Facebook" : activePlatform === "tiktok" ? "TikTok" : "Instagram"}.
      </p>
    </aside>
  );
}
