"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { Plus, Trash2, Video as VideoIcon, GripVertical } from "lucide-react";

import { cn } from "@/shared/utils";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import type { MediaAsset, MediaKind } from "@/ui/schemas/compose.schema";

export interface InlineMediaGridProps {
  media: readonly MediaAsset[];
  mediaKind: MediaKind;
  onReorder?: (next: MediaAsset[]) => void;
  onRemove?: (index: number) => void;
  onAddFiles?: (files: File[]) => void;
  disabled?: boolean;
  maxFiles?: number;
}

export function InlineMediaGrid({
  media,
  mediaKind,
  onReorder,
  onRemove,
  onAddFiles,
  disabled = false,
  maxFiles = mediaKind === "video" ? 1 : 10,
}: InlineMediaGridProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const canAddMore = media.length < maxFiles;
  const isVideo = mediaKind === "video";

  const handleFileDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled || !canAddMore) return;

    const files = Array.from(e.dataTransfer.files).filter((file) => {
      if (isVideo) return file.type.startsWith("video/");
      return file.type.startsWith("image/");
    });

    if (files.length > 0 && onAddFiles) {
      onAddFiles(files.slice(0, maxFiles - media.length));
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || disabled) return;
    const files = Array.from(e.target.files);
    if (files.length > 0 && onAddFiles) {
      onAddFiles(files.slice(0, maxFiles - media.length));
    }
    e.target.value = "";
  };

  const handleItemDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.setData("text/plain", String(index));
  };

  const handleItemDropOn = (e: DragEvent<HTMLDivElement>, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex || !onReorder) return;
    const next = [...media];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
    setDraggedIndex(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {media.map((asset, index) => (
          <div
            key={`${asset.driveFileId}-${index}`}
            draggable={!disabled && media.length > 1}
            onDragStart={(e) => handleItemDragStart(e, index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleItemDropOn(e, index)}
            className={cn(
              "group relative h-22 w-22 shrink-0 overflow-hidden rounded-xl border border-border bg-muted shadow-xs transition-all",
              draggedIndex === index && "opacity-50 ring-2 ring-[#622FF6]",
              media.length > 1 && "cursor-grab active:cursor-grabbing",
            )}
          >
            <MediaThumb asset={asset} alt={asset.fileName} lazy={index > 0} />

            {/* Top Badge: Ảnh bìa (Cover) */}
            {index === 0 && !isVideo && (
              <span className="absolute top-1.5 left-1.5 rounded-md bg-foreground/80 px-1.5 py-0.5 text-[9px] font-bold text-background tracking-wider uppercase backdrop-blur-xs">
                Bìa
              </span>
            )}

            {/* Video Indicator */}
            {isVideo && (
              <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-foreground/80 px-1.5 py-0.5 text-[10px] font-medium text-background backdrop-blur-xs">
                <VideoIcon className="size-3" />
                <span>Clip</span>
              </span>
            )}

            {/* Hover Actions: Drag Grip & Delete */}
            {!disabled && (
              <div className="absolute inset-0 flex items-center justify-between p-1.5 opacity-0 transition-opacity group-hover:opacity-100 bg-black/40">
                {media.length > 1 && (
                  <span className="text-white/90">
                    <GripVertical className="size-4" />
                  </span>
                )}
                <span className="flex-1" />
                {onRemove && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(index);
                    }}
                    className="flex size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-transform active:scale-90"
                    title="Xoá file này"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Dropzone Tile at the end */}
        {canAddMore && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleFileDrop}
            onClick={() => !disabled && fileInputRef.current?.click()}
            className={cn(
              "flex h-22 w-22 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border bg-card text-muted-foreground transition-colors hover:border-[#622FF6] hover:bg-[#622FF6]/5 hover:text-foreground",
              isDragOver && "border-[#622FF6] bg-[#622FF6]/10 text-[#622FF6]",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              ref={fileInputRef}
              id={inputId}
              type="file"
              accept={
                isVideo
                  ? "video/mp4,video/quicktime,video/webm"
                  : "image/jpeg,image/png,image/webp"
              }
              multiple={!isVideo}
              onChange={handleFileInputChange}
              disabled={disabled}
              className="sr-only"
            />
            <Plus className="size-5" />
            <span className="px-1 text-center text-[10px] font-medium leading-tight">
              {isVideo ? "Thêm video" : "Thêm ảnh"}
            </span>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {isVideo
          ? "Đăng 1 video clip cho bài viết."
          : `Đã chọn ${media.length}/${maxFiles} ảnh. Kéo thả để đổi ảnh bìa.`}
      </p>
    </div>
  );
}
