"use client";

import { useId, useState } from "react";

import { AlbumArranger } from "@/ui/components/compose/AlbumArranger";
import { formatBytes, removeAt, type QueuedFile } from "@/ui/components/compose/upload-queue";
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
 * The arranging half lives in `AlbumArranger`, shared with the Drive album:
 * both modes end with the same list, the same cover rule and the same
 * keyboard path (brief §8 — the two modes differ only in where files come
 * from).
 *
 * The file input is visually hidden but reachable, driven by a real <label> —
 * never `display:none` with a click handler (web-file-upload).
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
          Kéo file vào ô bên dưới hoặc bấm để chọn. Kéo từng dòng để đổi thứ tự — file đầu tiên là
          ảnh bìa. Tối đa {MAX_UPLOAD_FILES} file, mỗi file {formatBytes(MAX_UPLOAD_FILE_BYTES)}.
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
          className="text-primary cursor-pointer text-sm font-medium underline underline-offset-4"
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

      <AlbumArranger
        items={queue}
        onChange={onQueueChange}
        disabled={disabled}
        itemName={(item) => item.file.name}
        renderContent={(item) => (
          <>
            <span className="block truncate text-sm">{item.file.name}</span>
            <span className="text-muted-foreground text-xs">{formatBytes(item.file.size)}</span>
          </>
        )}
        renderActions={(item, index) => (
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
        )}
      />

      {/* The confirmation lives OUTSIDE the queue check on purpose: a successful
          upload empties the queue, and hiding the receipt with it would leave
          the operator with no sign anything happened. */}
      <div className="flex items-center gap-3">
        {queue.length > 0 ? (
          <Button type="button" onClick={props.onUpload} disabled={disabled || props.isUploading}>
            {props.isUploading ? "Đang tải lên…" : `Tải ${queue.length} file lên`}
          </Button>
        ) : null}
        {props.uploadedCount > 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            Đã lưu {props.uploadedCount} file cho bài này
            {queue.length > 0 ? " — bấm tải lên sẽ thay bằng danh sách mới." : "."}
          </p>
        ) : null}
      </div>

      {/* Adds and removals; moves are announced inside AlbumArranger. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
