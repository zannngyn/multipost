"use client";

import { useId, useState } from "react";

import { cn } from "@/shared/utils";

/**
 * What the caption will look like in a Facebook feed.
 *
 * It exists for one decision the operator cannot make from a textarea: Facebook
 * truncates a post around 125 characters on mobile, so whatever matters has to
 * be in the first two lines. The mobile view therefore cuts at the real
 * threshold and shows the real "Xem thêm" — a preview that showed everything
 * would be the pretty lie that hides the problem.
 *
 * The photos are the same labelled empty surfaces as the album grid: Phase 1
 * cannot fetch a Drive picture into the browser, and drawing a stand-in image
 * here would suggest the operator had checked something they had not.
 */
export function FacebookPreview({
  caption,
  pageName,
  mediaCount,
  isVideo,
}: {
  caption: string;
  pageName: string;
  mediaCount: number;
  isVideo: boolean;
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
      className="bg-card border-border flex w-full shrink-0 flex-col overflow-hidden rounded-xl border @4xl:w-100"
    >
      <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3.5">
        <h3 id={`${groupId}-heading`} className="flex-1 text-sm font-semibold">
          Xem trước bảng feed
        </h3>
        <div role="group" aria-label="Khổ màn hình xem trước" className="bg-muted flex gap-1 rounded-lg p-0.5">
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option}
              onClick={() => setDevice(option)}
              className={cn(
                "focus-visible:ring-ring/50 cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-3",
                device === option
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "desktop" ? "Desktop" : "Mobile"}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-background flex justify-center p-4">
        <div className={cn("w-full", isMobile && "max-w-85")}>
          <div
            className={cn(
              "border-border bg-card overflow-hidden border",
              isMobile ? "rounded-2xl" : "rounded-lg",
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

            <PreviewMedia count={mediaCount} isVideo={isVideo} />

            <div className="border-border text-muted-foreground flex border-t text-xs">
              {["Thích", "Bình luận", "Chia sẻ"].map((action) => (
                <span key={action} className="flex-1 py-2.5 text-center">
                  {action}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="border-border text-muted-foreground flex flex-col gap-1.5 border-t px-4 py-3.5 text-xs leading-relaxed">
        <p>
          Facebook cắt caption sau khoảng {MOBILE_CUTOFF} ký tự trên mobile — phần quan trọng nên ở
          hai dòng đầu.
        </p>
        <p>Ảnh chỉ là khung giữ chỗ: Phase 1 chưa tải ảnh từ Drive về trình duyệt.</p>
      </div>
    </aside>
  );
}

/** Where Facebook's mobile feed stops and offers "Xem thêm". */
const MOBILE_CUTOFF = 125;

/** The 2×2 collage Facebook builds from an album, with the usual "+N" overflow. */
function PreviewMedia({ count, isVideo }: { count: number; isVideo: boolean }) {
  if (count === 0) return null;

  if (isVideo || count === 1) {
    return (
      <div
        aria-hidden="true"
        className="bg-media-empty-cover text-foreground-subtle flex aspect-video items-center justify-center font-mono text-xs"
      >
        {isVideo ? "clip" : "ảnh bìa"}
      </div>
    );
  }

  const cells = Math.min(count, 4);
  const overflow = count - cells;

  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-0.5">
      {Array.from({ length: cells }, (_, index) => (
        <div
          key={index}
          className={cn(
            "relative flex aspect-square items-end justify-start p-1.5",
            index === 0 ? "bg-media-empty-cover" : "bg-media-empty",
          )}
        >
          {overflow > 0 && index === cells - 1 ? (
            <span className="bg-foreground/45 text-background absolute inset-0 flex items-center justify-center text-lg font-semibold">
              +{overflow}
            </span>
          ) : (
            <span className="bg-card/90 text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
              {index === 0 ? "bìa" : index + 1}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "FB";
  const letters = words.slice(-2).map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "FB";
}
