"use client";

import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset } from "@/ui/schemas/compose.schema";

/**
 * What the post will look like in a Facebook feed — the right-hand column of
 * the approved compose design, visible on every step rather than only while a
 * caption is being written.
 *
 * It exists for two decisions an operator cannot make from a textarea:
 *  - Facebook truncates a post around 125 characters on mobile, so whatever
 *    matters has to be in the first two lines. The mobile view cuts at the real
 *    threshold and shows the real "Xem thêm" — a preview that showed everything
 *    would be the pretty lie that hides the problem;
 *  - the collage. Facebook crops an album into a 2×2 grid with a "+N" overflow,
 *    and which photo ends up as the big one is exactly what the cover choice on
 *    step 1 decides. The photos here are the REAL photos, pulled through the
 *    session-authenticated preview route.
 *
 * HARD RULE (CLAUDE.md business rule 2): this is the preview of what goes
 * public. Stock, price and production notes have no place in it — the internal
 * operator block lives on step 1 and stays there.
 */
export function FacebookPreview({
  caption,
  pageName,
  media,
  isVideo,
  className,
}: {
  caption: string;
  pageName: string;
  /** The album in publish order; index 0 is the cover. */
  media: readonly MediaAsset[];
  isVideo: boolean;
  className?: string;
}) {
  const groupId = useId();
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [expanded, setExpanded] = useState(false);

  const text = caption.trim();
  const isMobile = device === "mobile";
  const isCut = isMobile && !expanded && text.length > MOBILE_CUTOFF;

  return (
    <aside
      aria-labelledby={`${groupId}-heading`}
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3
          id={`${groupId}-heading`}
          className="text-foreground-subtle flex-1 font-mono text-xs tracking-widest uppercase"
        >
          Xem trước · Facebook
        </h3>
        <div
          role="group"
          aria-label="Khổ màn hình xem trước"
          className="bg-muted flex gap-1 rounded-lg p-0.5"
        >
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option}
              onClick={() => setDevice(option)}
              className={cn(
                "focus-visible:ring-ring/50 cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-3",
                device === option
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "desktop" ? "Desktop" : "Mobile"}
            </button>
          ))}
        </div>
      </div>

      <div
        className={cn(
          "bg-card border-border overflow-hidden border transition-[max-width]",
          isMobile ? "max-w-90 self-center rounded-3xl" : "w-full rounded-2xl",
        )}
      >
        <div className="flex items-center gap-2.5 p-4">
          <span
            aria-hidden="true"
            className="bg-accent text-accent-foreground flex size-9 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initialsOf(pageName)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{pageName}</span>
            <span className="text-muted-foreground text-xs">Vừa xong · Công khai</span>
          </span>
        </div>

        <div className="px-4 pb-3 text-sm leading-relaxed">
          {text.length === 0 ? (
            <p className="text-muted-foreground italic">
              Chưa có caption — bài chưa thể chuyển sang bước xem lại.
            </p>
          ) : isCut ? (
            <p className="whitespace-pre-wrap">
              {text.slice(0, MOBILE_CUTOFF)}…{" "}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-muted-foreground hover:text-foreground cursor-pointer font-medium underline underline-offset-2"
              >
                Xem thêm
              </button>
            </p>
          ) : (
            <p className="whitespace-pre-wrap">{text}</p>
          )}
        </div>

        <PreviewMedia media={media} isVideo={isVideo} />

        <div className="border-border text-muted-foreground flex border-t text-xs">
          {["Thích", "Bình luận", "Chia sẻ"].map((action) => (
            <span key={action} className="flex-1 py-2.5 text-center">
              {action}
            </span>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Facebook cắt caption sau khoảng {MOBILE_CUTOFF} ký tự trên mobile — phần quan trọng nên ở hai
        dòng đầu. Khung ảnh bên trên là cách Facebook ghép album, không phải kích thước thật của ảnh.
      </p>
    </aside>
  );
}

/** Where Facebook's mobile feed stops and offers "Xem thêm". */
const MOBILE_CUTOFF = 125;

/**
 * The collage Facebook builds from an album: one large cell beside the rest,
 * with the usual "+N" over the last visible tile.
 *
 * Not `aria-hidden`: the album is part of the post, so it gets a plain-language
 * summary instead of being hidden from anyone who cannot see it.
 */
function PreviewMedia({ media, isVideo }: { media: readonly MediaAsset[]; isVideo: boolean }) {
  if (media.length === 0) return null;

  if (isVideo || media.length === 1) {
    return (
      <figure className="m-0">
        <div className="bg-media-empty-cover relative aspect-video">
          <MediaThumb asset={media[0]} alt="" lazy={false} />
        </div>
        <figcaption className="sr-only">
          {isVideo ? "Bài video, một clip" : `Bài một ảnh: ${media[0].fileName}`}
        </figcaption>
      </figure>
    );
  }

  const cells = Math.min(media.length, 4);
  const overflow = media.length - cells;

  return (
    <figure className="m-0">
      <div className="grid grid-cols-2 gap-0.5">
        {media.slice(0, cells).map((asset, index) => (
          <div
            key={asset.driveFileId}
            className={cn(
              "relative aspect-square",
              index === 0 ? "bg-media-empty-cover" : "bg-media-empty",
            )}
          >
            <MediaThumb asset={asset} alt="" lazy={index > 0} />
            {overflow > 0 && index === cells - 1 ? (
              <span
                aria-hidden="true"
                className="bg-foreground/45 text-background absolute inset-0 z-1 flex items-center justify-center text-lg font-semibold"
              >
                +{overflow}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <figcaption className="sr-only">
        Album {media.length} ảnh, ảnh bìa là {media[0].fileName}
        {overflow > 0 ? `; Facebook gộp ${overflow} ảnh cuối vào ô “+${overflow}”` : ""}.
      </figcaption>
    </figure>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "FB";
  const letters = words.slice(-2).map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "FB";
}
