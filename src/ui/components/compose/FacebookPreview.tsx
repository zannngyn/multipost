"use client";

import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import { splitCaptionTags } from "@/ui/components/compose/caption-text";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset } from "@/ui/schemas/compose.schema";

/**
 * The right-hand column of the ComposeFocus design (template lines 133–159):
 * the post as a Facebook feed draws it, beside the card that composes it.
 *
 * Faithful to the template in the parts that matter to a decision:
 *  - the header is a real post header — avatar, page name, "Vừa xong · Công
 *    khai" (141–143);
 *  - the caption is cut where Facebook cuts it, with the real "Xem thêm"
 *    (144). A preview that showed everything would be the pretty lie that hides
 *    the problem;
 *  - hashtags sit on their own blue line, as they do in the feed (145);
 *  - the collage is Facebook's ALBUM collage: a tall left column of two, and a
 *    right column of up to three with "+N" over the last (146–155). Which photo
 *    ends up big is exactly what the cover choice decides, which is why the
 *    strip and this frame have to agree;
 *  - Desktop / Mobile toggle (137–139) — mobile narrows the frame to the width
 *    a phone actually gives the post and shortens the tiles (`frame-mob`, 23).
 *
 * HARD RULE (CLAUDE.md business rule 2): this is the preview of what goes
 * PUBLIC. Stock, price and production notes have no place in it — the internal
 * operator notes live on the left card and stay there.
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

  const { body, tags } = splitCaptionTags(caption);
  const text = body.trim();
  const isMobile = device === "mobile";
  const isCut = !expanded && text.length > MOBILE_CUTOFF;

  return (
    <aside
      aria-labelledby={`${groupId}-heading`}
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2
          id={`${groupId}-heading`}
          className="flex-1 font-mono text-[10px] tracking-[0.12em] text-[var(--foreground-subtle)] uppercase"
        >
          Xem trước · Facebook
        </h2>

        <div
          role="group"
          aria-label="Khổ màn hình xem trước"
          className="flex gap-[3px] rounded-[10px] bg-[var(--compose-track)] p-[3px]"
        >
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option}
              onClick={() => setDevice(option)}
              className={cn(
                "focus-visible:ring-ring h-7 cursor-pointer rounded-lg px-3 text-xs font-medium text-[var(--compose-text-2)] transition-colors outline-none focus-visible:ring-3",
                device === option &&
                  "bg-[var(--compose-raised)] font-semibold text-[var(--primary)] shadow-[0_1px_3px_rgba(34,31,28,0.14)]",
              )}
            >
              {option === "desktop" ? "Desktop" : "Mobile"}
            </button>
          ))}
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col overflow-hidden bg-[var(--card)] transition-[max-width]",
          "shadow-[inset_0_0_0_1px_var(--compose-hairline)]",
          isMobile
            ? "max-w-90 self-center rounded-[22px] shadow-[inset_0_0_0_1px_var(--compose-hairline),0_12px_30px_rgba(34,31,28,0.12)]"
            : "w-full rounded-[var(--compose-radius-block)]",
        )}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-semibold text-[var(--accent-foreground)]"
          >
            {initialsOf(pageName)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{pageName}</span>
            <span className="text-xs text-[var(--muted-foreground)]">Vừa xong · Công khai</span>
          </span>
        </div>

        <div className="px-4 pb-3 text-sm leading-[23px]">
          {text.length === 0 ? (
            <p className="text-[var(--muted-foreground)] italic">
              Chưa có caption — bài chưa đăng được.
            </p>
          ) : isCut ? (
            <p className="whitespace-pre-wrap">
              {text.slice(0, MOBILE_CUTOFF)}…{" "}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="focus-visible:ring-ring cursor-pointer rounded-sm font-semibold outline-none focus-visible:ring-3"
              >
                Xem thêm
              </button>
            </p>
          ) : (
            <p className="whitespace-pre-wrap">{text}</p>
          )}
        </div>

        {tags.length > 0 ? (
          <div className="px-4 pb-3 text-sm break-words text-[var(--compose-link)]">{tags}</div>
        ) : null}

        <PreviewCollage media={media} isVideo={isVideo} compact={isMobile} />

        <div className="flex h-12 items-center shadow-[inset_0_1px_0_var(--compose-hairline)]">
          {["Thích", "Bình luận", "Chia sẻ"].map((action) => (
            <span
              key={action}
              className="flex-1 text-center text-[13px] text-[var(--compose-text-2)]"
            >
              {action}
            </span>
          ))}
        </div>
      </div>

      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        Facebook cắt caption sau khoảng {MOBILE_CUTOFF} ký tự — phần quan trọng nên ở hai dòng đầu.
        Khung ảnh bên trên là cách Facebook ghép album, không phải kích thước thật của ảnh.
      </p>
    </aside>
  );
}

/** Where Facebook's feed stops and offers "Xem thêm". */
const MOBILE_CUTOFF = 125;

/**
 * Facebook's album collage: two tall tiles on the left, up to three on the
 * right, "+N" over the last visible one (template 146–155).
 *
 * Not `aria-hidden`: the album is part of the post, so it gets a plain-language
 * summary instead of being hidden from anyone who cannot see it.
 */
function PreviewCollage({
  media,
  isVideo,
  compact,
}: {
  media: readonly MediaAsset[];
  isVideo: boolean;
  /** Mobile frame — the template shortens the left tiles to 180px (line 24). */
  compact: boolean;
}) {
  if (media.length === 0) return null;

  if (isVideo || media.length === 1) {
    return (
      <figure className="m-0">
        <div className="relative aspect-video bg-[var(--media-empty-cover)]">
          <MediaThumb asset={media[0]} alt="" lazy={false} />
        </div>
        <figcaption className="sr-only">
          {isVideo ? "Bài video, một clip" : `Bài một ảnh: ${media[0].fileName}`}
        </figcaption>
      </figure>
    );
  }

  // Exactly what Facebook shows: two big, three small, everything past that
  // folded into the "+N" tile.
  const left = media.slice(0, 2);
  const right = media.slice(2, 5);
  const overflow = Math.max(0, media.length - left.length - right.length);
  const tileHeight = compact ? "h-45" : "h-57";

  return (
    <figure className="m-0">
      <div className="grid grid-cols-[1.55fr_1fr] gap-[3px] bg-[var(--card)]">
        <div className="flex flex-col gap-[3px]">
          {left.map((asset, index) => (
            <div
              key={asset.driveFileId}
              className={cn("relative bg-[var(--media-empty-cover)]", tileHeight)}
            >
              <MediaThumb asset={asset} alt="" lazy={index > 0} />
            </div>
          ))}
        </div>

        {right.length > 0 ? (
          <div className="flex flex-col gap-[3px]">
            {right.map((asset, index) => (
              <div
                key={asset.driveFileId}
                className="relative min-h-25 flex-1 bg-[var(--media-empty)]"
              >
                <MediaThumb asset={asset} alt="" />
                {overflow > 0 && index === right.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 z-1 flex items-center justify-center bg-[var(--compose-veil)] text-[22px] font-semibold text-white"
                  >
                    +{overflow}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
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
