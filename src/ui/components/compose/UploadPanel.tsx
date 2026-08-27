"use client";

import { useEffect, useId, useRef, useState } from "react";

import { AlbumArranger } from "@/ui/components/compose/AlbumArranger";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
import {
  formatBytes,
  isPreviewable,
  removeAt,
  syncPreviewUrls,
  type QueuedFile,
} from "@/ui/components/compose/upload-queue";
import { Button } from "@/ui/components/ui/button";
import { Progress } from "@/ui/components/ui/progress";
import {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_ACCEPT,
  type UploadedAsset,
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
  /** 0..100 — real progress of the browser -> storage POSTs, not a guess. */
  progress: number;
  /** Cuts the upload's network calls, not just the button state. */
  onCancel: () => void;
  /** Files the SERVER refused on the last attempt, with its reasons. */
  rejected: readonly UploadRejection[];
  /** Set once the upload succeeded, so the operator sees the album is stored. */
  uploadedCount: number;
  /**
   * The stored files themselves (E9 T8). Optional so this panel keeps
   * rendering — with the count line only — if a caller has not been updated
   * to pass it yet; defaults to none, never a guess at what got stored.
   */
  uploadedAssets?: readonly UploadedAsset[];
  /**
   * Non-blocking notes from the confirm step — e.g. a malformed album order
   * that was silently corrected server-side. Business rule 5 (không im lặng
   * bỏ qua): these MUST reach the operator, not just the server log.
   */
  warnings: readonly string[];
  disabled?: boolean;
}

export function UploadPanel(props: UploadPanelProps) {
  const inputId = useId();
  const [isOver, setIsOver] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const { queue, onQueueChange, disabled } = props;
  const full = queue.length >= MAX_UPLOAD_FILES;
  const uploadedAssets = props.uploadedAssets ?? [];

  /**
   * One object URL per image still waiting to upload, built from the File
   * already in memory — costs 0 bytes on the wire. `previewsRef` is the
   * source of truth read/written by effects; `previews` state is only what
   * gets rendered.
   */
  const previewsRef = useRef<Map<string, string>>(new Map());
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());

  /**
   * Reconciles previews against `queue`: reuses the url of any id still
   * present, creates one for every new image, and revokes exactly the urls
   * whose id left the queue — never the ones still on screen. Doing this in
   * the effect BODY (not a returned cleanup) matters: React StrictMode
   * double-invokes effects once right after mount, and a cleanup that
   * revokes "whatever's current" would revoke the very url the <img> just
   * painted is pointing at (web-file-upload §3).
   */
  useEffect(() => {
    const { next, revoked } = syncPreviewUrls(previewsRef.current, queue, (file) =>
      URL.createObjectURL(file),
    );
    for (const url of revoked) URL.revokeObjectURL(url);
    previewsRef.current = next;
    setPreviews(next);
  }, [queue]);

  /**
   * Mount-only: revokes whatever remains when the panel truly leaves the
   * tree. Its cleanup ALSO fires once during StrictMode's dev-only
   * setup→cleanup→setup dance right after mount — clearing the ref there is
   * what makes that dance harmless: the sync effect's second run then sees
   * an empty map and creates fresh urls instead of reusing ones this
   * cleanup just revoked.
   */
  useEffect(() => {
    return () => {
      for (const url of previewsRef.current.values()) URL.revokeObjectURL(url);
      previewsRef.current = new Map();
    };
  }, []);

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

      {/* Corrections `confirmUpload` made without asking — must never be
          silent (business rule 5). Kept OUTSIDE the caption/preview blocks
          this component does not own; this is the only place these notes can
          land for the operator. */}
      {props.warnings.length > 0 ? (
        <div className="border-warning/40 bg-warning/10 space-y-1 rounded-lg border p-3" role="alert">
          <p className="text-warning-foreground text-sm font-medium">Lưu ý khi lưu file:</p>
          <ul className="text-warning-foreground space-y-1 text-sm">
            {props.warnings.map((message) => (
              <li key={message}>{message}</li>
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
          <div className="flex min-w-0 items-center gap-3">
            {/* Fixed-size tile so the list never shifts once the image
                decodes (CLS = 0). `aria-hidden`: the filename right next to
                it already names the file — reading both would be noise for
                a screen reader (web-accessibility — decorative image). */}
            <div className="bg-muted relative h-12 w-12 shrink-0 overflow-hidden rounded">
              {previews.get(item.id) ? (
                /* next/image cannot optimize a blob: URL — it never leaves the
                   browser, so there is nothing for the optimizer to fetch. */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previews.get(item.id)}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-muted-foreground flex h-full w-full items-center justify-center text-xs">
                  {isPreviewable(item.file) ? "…" : "Video"}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <span className="block truncate text-sm">{item.file.name}</span>
              <span className="text-muted-foreground text-xs">{formatBytes(item.file.size)}</span>
            </div>
          </div>
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

      {/* E9 T8 — what got stored, drawn AFTER the queue empties. The queue's own
          thumbnails die with it (their object URLs are revoked the moment the
          file leaves the browser); these come from the server's preview
          route instead, through the same `MediaThumb` the rest of the screen
          uses (component-reuse) — no second loading/ready/failed state to
          maintain here. */}
      {uploadedAssets.length > 0 && !props.isUploading ? (
        <ul className="flex flex-wrap gap-2" aria-label="File đã lưu cho bài này">
          {uploadedAssets.map((asset) => (
            <li key={asset.assetId} className="w-16">
              <div className="bg-muted relative h-16 w-16 overflow-hidden rounded">
                <MediaThumb asset={{ ...asset, driveFileId: asset.assetId }} alt="" />
              </div>
              <span className="text-muted-foreground mt-1 block truncate text-xs">
                {asset.fileName}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The confirmation lives OUTSIDE the queue check on purpose: a successful
          upload empties the queue, and hiding the receipt with it would leave
          the operator with no sign anything happened. */}
      <div className="flex items-center gap-3">
        {queue.length > 0 && !props.isUploading ? (
          <Button type="button" onClick={props.onUpload} disabled={disabled}>
            {`Tải ${queue.length} file lên`}
          </Button>
        ) : null}
        {props.isUploading ? (
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Huỷ tải lên
          </Button>
        ) : null}
        {props.uploadedCount > 0 && !props.isUploading ? (
          <p className="text-muted-foreground text-sm" role="status">
            Đã lưu {props.uploadedCount} file cho bài này
            {queue.length > 0 ? " — bấm tải lên sẽ thay bằng danh sách mới." : "."}
          </p>
        ) : null}
      </div>

      {/* Real progress, straight to the browser -> storage POSTs (stage 2).
          `aria-live="polite"` announces a change in this text — and ONLY a
          change: `progress` updates once per completed file, not on a timer,
          so there is nothing here to re-announce on every tick (see commit
          5a9b78a — that regression was the batch screen reading `isFetching`
          on every poll instead of a value that actually moved). */}
      {props.isUploading ? (
        <div className="space-y-1" role="status" aria-live="polite">
          <Progress
            value={props.progress}
            label="Tiến độ tải file lên"
            valueText={`${props.progress}%`}
          />
          <p className="text-muted-foreground text-sm">Đang tải lên {props.progress}%.</p>
        </div>
      ) : null}

      {/* Adds and removals; moves are announced inside AlbumArranger. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
