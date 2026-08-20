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
  const url = asset.kind === "video" ? null : mediaPreviewUrl(asset.driveFileId);

  const [phase, setPhase] = useState<Phase>("loading");
  // Adjusting state during render (the documented React alternative to an
  // effect): a tile reused for another asset after a reorder must go back to
  // "loading", or it would show the previous photo until the new bytes land.
  const [renderedUrl, setRenderedUrl] = useState<string | null>(url);
  if (renderedUrl !== url) {
    setRenderedUrl(url);
    setPhase("loading");
  }

  const note = describe(asset, url, phase);

  return (
    <span className={cn("absolute inset-0 block overflow-hidden", className)}>
      {url ? (
        /* next/image cannot help here: the bytes come from a per-session,
           per-tenant API route with `Cache-Control: private`, so the optimizer
           must not proxy or cache them, and the intrinsic size is unknown until
           the response arrives. The parent owns the box, so there is no layout
           shift to protect against either. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt ?? `Ảnh ${asset.fileName}`}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          draggable={false}
          onLoad={() => setPhase("ready")}
          // Not swallowed: a failed preview becomes a visible, worded surface
          // instead of an icon nobody can act on.
          onError={() => setPhase("failed")}
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
