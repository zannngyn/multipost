"use client";

import { useState } from "react";

import { cn } from "@/shared/utils";
import type { MediaAsset } from "@/ui/schemas/compose.schema";
import { mediaPreviewUrl } from "@/ui/services/media-preview";

/**
 * ONE picture of ONE asset, with the three answers a picture can give.
 *
 * The whole compose screen renders photos through this component — album tiles,
 * the Facebook collage, the strip — so "what does a photo look like while it
 * loads, and what does it look like when it will never load" is decided once.
 *
 * Three states, none of them the browser's default (web-feedback-states §1):
 *  - loading  → the same tinted surface the tile already used, so nothing moves
 *               when the bytes arrive (CLS = 0: the PARENT owns the box);
 *  - ready    → the photo, cropped to fill;
 *  - failed   → a labelled surface saying it could not be loaded. Never the
 *               browser's broken-image glyph, which looks like a bug in MYSP and
 *               tells the operator nothing.
 *
 * A video asset has no still to show — there is no thumbnail route for a clip —
 * so it is a labelled surface by design, not a failure.
 *
 * Fills its parent: the parent must be `relative` and must own the aspect ratio.
 */

type Phase = "loading" | "ready" | "failed";

export function MediaThumb({
  asset,
  alt,
  className,
  /** Cheap for a strip of ten tiles; turn off for the one image above the fold. */
  lazy = true,
}: {
  asset: Pick<MediaAsset, "driveFileId" | "fileName" | "kind">;
  /** Empty string = decorative, when the filename is already written beside it. */
  alt?: string;
  className?: string;
  lazy?: boolean;
}) {
  const initialUrl = asset.kind === "video" ? null : mediaPreviewUrl(asset.driveFileId);
  const [currentUrl, setCurrentUrl] = useState<string | null>(initialUrl);
  const [phase, setPhase] = useState<Phase>("loading");
  const [hasTriedFallback, setHasTriedFallback] = useState(false);

  // Adjusting state during render when asset changes
  const [renderedAssetId, setRenderedAssetId] = useState(asset.driveFileId);
  if (renderedAssetId !== asset.driveFileId) {
    setRenderedAssetId(asset.driveFileId);
    setCurrentUrl(initialUrl);
    setPhase("loading");
    setHasTriedFallback(false);
  }

  const handleImageError = () => {
    const id = (asset.driveFileId ?? "").trim();
    if (
      !hasTriedFallback &&
      id.length > 0 &&
      !id.startsWith("upload_") &&
      !id.startsWith("blob:") &&
      !id.startsWith("data:") &&
      !id.startsWith("http")
    ) {
      setHasTriedFallback(true);
      setCurrentUrl(`https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w800`);
      return;
    }
    setPhase("failed");
  };

  const note = describe(asset, currentUrl, phase);

  return (
    <span className={cn("absolute inset-0 block overflow-hidden", className)}>
      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={alt ?? `Ảnh ${asset.fileName}`}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          draggable={false}
          onLoad={() => setPhase("ready")}
          onError={handleImageError}
          className={cn(
            "h-full w-full object-cover",
            phase === "ready" ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}

      {note ? (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center px-2 text-center font-mono text-[0.6875rem] leading-tight",
            note.tone === "pending"
              ? "text-foreground-subtle motion-safe:animate-pulse"
              : "text-warning-foreground",
          )}
        >
          {note.text}
        </span>
      ) : null}
    </span>
  );
}

/** What the surface says while there is no photo on it. Null once there is. */
function describe(
  asset: Pick<MediaAsset, "driveFileId" | "kind">,
  url: string | null,
  phase: Phase,
): { text: string; tone: "pending" | "problem" } | null {
  if (asset.kind === "video") return { text: "clip — chưa xem trước được", tone: "problem" };
  if (url === null) return { text: "thiếu mã file", tone: "problem" };
  if (phase === "failed") return { text: "không tải được ảnh", tone: "problem" };
  if (phase === "loading") return { text: "đang tải…", tone: "pending" };
  return null;
}
