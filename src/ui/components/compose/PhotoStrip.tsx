"use client";

import { X } from "lucide-react";
import { useState } from "react";

import { cn } from "@/shared/utils";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import { makeCover, moveItem, removeAt } from "@/ui/components/compose/upload-queue";
import type { MediaAsset } from "@/ui/schemas/compose.schema";

/**
 * The album, drawn as the template's strip (lines 74–81): 96×128 tiles with a
 * round ✕ top-right, a "Bìa" badge bottom-left on the cover, and "N ảnh" at the
 * end of the row.
 *
 * Gestures, and why each exists:
 *  - press a tile        → that photo becomes the cover (template line 76).
 *    The cover is the ONE thing about the order that changes the post, so it is
 *    the one-press action;
 *  - ← / → on a tile     → move it one place. Dragging is not the only way to
 *    order an album (core-accessibility): the strip is short and arrow keys are
 *    the cheapest honest keyboard path;
 *  - ✕                   → drop the photo from the post. Never the last one:
 *    an album of zero cannot be published, and the button says so instead of
 *    disappearing.
 *
 * Every move is announced in a polite live region, because a reordered strip is
 * invisible to anyone who cannot see it.
 *
 * The tiles show the REAL photo through the session-authenticated preview route
 * (`MediaThumb`), which draws its own loading / failed states — approving a
 * photo nobody can see is the thing this screen must never allow.
 */
export function PhotoStrip({
  media,
  onChange,
  disabled = false,
}: {
  /** The album in publish order; index 0 is the cover. */
  media: readonly MediaAsset[];
  onChange: (next: MediaAsset[]) => void;
  disabled?: boolean;
}) {
  const [announcement, setAnnouncement] = useState("");

  // A one-clip video post has nothing to arrange and no cover to choose.
  const isVideo = media[0]?.kind === "video";
  const arrangeable = !isVideo && media.length > 1;

  function apply(next: MediaAsset[], message: string) {
    onChange(next);
    setAnnouncement(message);
  }

  function setCover(index: number) {
    if (disabled || !arrangeable || index === 0) return;
    apply(
      makeCover(media, index),
      `${media[index].fileName} là ảnh bìa, ở vị trí 1 trên ${media.length}.`,
    );
  }

  function move(index: number, delta: number) {
    if (disabled || !arrangeable) return;
    const to = index + delta;
    if (to < 0 || to >= media.length) return;
    apply(
      moveItem(media, index, to),
      `${media[index].fileName} chuyển sang vị trí ${to + 1} trên ${media.length}.`,
    );
  }

  function drop(index: number) {
    if (disabled || media.length <= 1) return;
    const removed = media[index];
    apply(
      removeAt(media, index),
      `Đã bỏ ${removed.fileName} khỏi bài. Còn ${media.length - 1} ảnh.`,
    );
  }

  return (
    <section aria-labelledby="compose-album-heading" className="flex flex-col gap-2.5">
      <h3 id="compose-album-heading" className="sr-only">
        {isVideo ? "Clip sẽ đăng" : "Ảnh sẽ đăng"}
      </h3>

      <div className="flex items-center gap-3 overflow-x-auto pb-1">
        {media.map((asset, index) => (
          <div
            key={asset.driveFileId}
            className={cn(
              "relative h-32 w-24 shrink-0 overflow-hidden rounded-md bg-[var(--media-empty)]",
              "shadow-[inset_0_0_0_1px_var(--border)]",
              index === 0 &&
                !isVideo &&
                "shadow-[inset_0_0_0_2.5px_var(--primary)]",
            )}
          >
            <button
              type="button"
              aria-pressed={index === 0}
              aria-disabled={disabled || !arrangeable}
              onClick={() => setCover(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  move(index, 1);
                }
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(index, -1);
                }
              }}
              className="focus-visible:ring-ring absolute inset-0 cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-inset"
            >
              <MediaThumb asset={asset} alt="" lazy={index > 1} />
              <span className="sr-only">
                {asset.fileName} — vị trí {index + 1} trên {media.length}.
                {index === 0
                  ? " Đang là ảnh bìa."
                  : arrangeable
                    ? " Nhấn để đặt làm ảnh bìa."
                    : ""}
                {arrangeable ? " Dùng mũi tên trái/phải để đổi thứ tự." : ""}
              </span>
            </button>

            {media.length > 1 ? (
              <button
                type="button"
                onClick={() => drop(index)}
                disabled={disabled}
                aria-label={`Bỏ ${asset.fileName} khỏi bài`}
                className="focus-visible:ring-ring bg-foreground/65 text-background absolute top-1.5 right-1.5 z-1 flex size-5.5 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-3" strokeWidth={2.5} />
              </button>
            ) : null}

            {index === 0 && !isVideo ? (
              <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-1 rounded-sm bg-[var(--card)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)]">
                Bìa
              </span>
            ) : null}

            {asset.needsReview ? (
              <span
                aria-hidden="true"
                className="absolute right-1.5 bottom-1.5 z-1 size-2 rounded-full bg-[var(--warning)]"
                title="File cần rà soát tên"
              />
            ) : null}
          </div>
        ))}

        <span className="shrink-0 text-[13px] text-[var(--muted-foreground)]">
          {isVideo ? "1 clip" : `${media.length} ảnh`}
        </span>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        {isVideo
          ? "Bài video dùng đúng một clip — chưa xem trước được clip trên màn hình này."
          : "Bấm vào một ô để đặt làm ảnh bìa, ✕ để bỏ ảnh khỏi bài. Ô nào báo “không tải được ảnh” là file đã bị xoá hoặc hỏng trên Drive."}
      </p>
    </section>
  );
}
