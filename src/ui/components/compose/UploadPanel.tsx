"use client";

import { useId, useRef, useState } from "react";

import {
  describeMove,
  formatBytes,
  makeCover,
  moveItem,
  removeAt,
  type QueuedFile,
} from "@/ui/components/compose/upload-queue";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_ACCEPT,
  type UploadRejection,
} from "@/ui/schemas/compose.schema";

/**
 * E9.2 — mode B file picker: drop files from the machine, arrange them, send.
 *
 * The list IS the album (brief §8): index 0 is the cover, and the order shown is
 * the order sent.
 *
 * Accessibility, per web-file-upload and web-drag-drop-reorder:
 *   - the file input is visually hidden but reachable, driven by a real
 *     <label> — never `display:none` with a click handler;
 *   - dropping is an ADDITION, never the only way in: the picker and the
 *     reorder buttons work with a keyboard alone;
 *   - every move is announced in an aria-live region, because a reorder is
 *     invisible to anyone not watching the list.
 *
 * Reordering is buttons, not pointer-drag. Hand-rolled drag-to-reorder is the
 * single easiest thing to get wrong for a11y (the skill says so), and the
 * library that does it properly is a dependency this project has not approved.
 */

export interface UploadPanelProps {
  /** Files already chosen but not yet sent. */
  queue: readonly QueuedFile[];
  onQueueChange: (next: QueuedFile[]) => void;
  onUpload: () => void;
  isUploading: boolean;
  /** Files the SERVER refused on the last attempt, with its reasons. */
  rejected: readonly UploadRejection[];
  /** Set once the upload succeeded, so the operator sees the album is stored. */
  uploadedCount: number;
  disabled?: boolean;
}

export function UploadPanel(props: UploadPanelProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOver, setIsOver] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const { queue, onQueueChange, disabled } = props;
  const full = queue.length >= MAX_UPLOAD_FILES;

  /**
   * Client-side triage is UX, not security: it saves a pointless round trip.
   * The server re-checks size AND sniffs the real type, so nothing here is
   * load-bearing (core-file-upload: two layers, server decides).
   */
  function addFiles(incoming: FileList | null) {
    if (!incoming || incoming.length === 0) return;

    const errors: string[] = [];
    const accepted: QueuedFile[] = [];
    let room = MAX_UPLOAD_FILES - queue.length;

    for (const file of Array.from(incoming)) {
      if (room <= 0) {
        errors.push(`Chỉ nhận tối đa ${MAX_UPLOAD_FILES} file — "${file.name}" chưa được thêm.`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`"${file.name}" rỗng — chưa được thêm.`);
        continue;
      }
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        errors.push(
          `"${file.name}" nặng ${formatBytes(file.size)} — vượt mức tối đa ${formatBytes(MAX_UPLOAD_FILE_BYTES)}.`,
        );
        continue;
      }
      accepted.push({ id: `${file.name}-${file.size}-${file.lastModified}-${room}`, file });
      room -= 1;
    }

    setLocalErrors(errors);
    if (accepted.length > 0) {
      onQueueChange([...queue, ...accepted]);
      setAnnouncement(`Đã thêm ${accepted.length} file. Tổng ${queue.length + accepted.length}.`);
    }
  }

  function move(from: number, to: number) {
    const next = moveItem(queue, from, to);
    if (next === queue) return;
    onQueueChange(next);
    const moved = queue[from];
    const position = next.findIndex((item) => item.id === moved.id);
    setAnnouncement(describeMove(moved.file.name, position, next.length));
  }

  function cover(index: number) {
    const next = makeCover(queue, index);
    onQueueChange(next);
    setAnnouncement(describeMove(queue[index].file.name, 0, next.length));
  }

  function remove(index: number) {
    const removed = queue[index];
    onQueueChange(removeAt(queue, index));
    setAnnouncement(`Đã bỏ ${removed.file.name}.`);
  }

  return (
    <section className="space-y-4" aria-labelledby={`${inputId}-heading`}>
      <div className="space-y-1">
        <h3 id={`${inputId}-heading`} className="text-sm font-medium">
          File của bài này
        </h3>
        <p className="text-muted-foreground text-sm">
          Kéo file vào ô bên dưới hoặc bấm để chọn. File đầu tiên là ảnh bìa. Tối đa{" "}
          {MAX_UPLOAD_FILES} file, mỗi file {formatBytes(MAX_UPLOAD_FILE_BYTES)}.
        </p>
      </div>

      {/* The drop target. `onClick` is deliberately absent: the <label> already
          activates the input, so a keyboard user gets the same behaviour. */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsOver(true);
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsOver(false);
          if (!disabled) addFiles(event.dataTransfer.files);
        }}
        className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          isOver ? "border-primary bg-primary/5" : "border-muted-foreground/25"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          disabled={disabled || full}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.target.files);
            // Let the same file be picked again after it was removed.
            event.target.value = "";
          }}
        />
        <label
          htmlFor={inputId}
          className="text-primary cursor-pointer text-sm font-medium underline underline-offset-4 focus-within:outline-none"
        >
          Chọn file từ máy
        </label>
        <p className="text-muted-foreground mt-1 text-xs">
          hoặc kéo thả vào đây · JPG, PNG, WEBP, MP4, MOV
        </p>
      </div>

      {localErrors.length > 0 ? (
        <ul className="text-destructive space-y-1 text-sm" role="alert">
          {localErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {props.rejected.length > 0 ? (
        <div className="border-destructive/30 bg-destructive/5 space-y-1 rounded-lg border p-3">
          <p className="text-destructive text-sm font-medium">Máy chủ từ chối một số file:</p>
          <ul className="text-destructive space-y-1 text-sm">
            {props.rejected.map((item) => (
              <li key={`${item.fileName}-${item.reason}`}>{item.userMessage}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {queue.length > 0 ? (
        <ol className="divide-border divide-y rounded-lg border">
          {queue.map((item, index) => (
            <li key={item.id} className="flex items-center gap-3 p-3">
              <span className="text-muted-foreground w-6 shrink-0 text-sm tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.file.name}</span>
                <span className="text-muted-foreground text-xs">
                  {formatBytes(item.file.size)}
                </span>
              </span>
              {index === 0 ? <Badge>Ảnh bìa</Badge> : null}
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, index - 1)}
                  aria-label={`Đưa ${item.file.name} lên trên`}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || index === queue.length - 1}
                  onClick={() => move(index, index + 1)}
                  aria-label={`Đưa ${item.file.name} xuống dưới`}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || index === 0}
                  onClick={() => cover(index)}
                >
                  Đặt làm bìa
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => remove(index)}
                  aria-label={`Bỏ ${item.file.name}`}
                >
                  Bỏ
                </Button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {queue.length > 0 ? (
        <div className="flex items-center gap-3">
          <Button type="button" onClick={props.onUpload} disabled={disabled || props.isUploading}>
            {props.isUploading ? "Đang tải lên…" : `Tải ${queue.length} file lên`}
          </Button>
          {props.uploadedCount > 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              Đã lưu {props.uploadedCount} file cho bài này.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Announces adds, moves and removals for anyone not watching the list. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
