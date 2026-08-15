"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type DragEndEvent,
  type Over,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import {
  SortableContext,
  hasSortableData,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useId, useState } from "react";

import {
  describeMove,
  formatBytes,
  indexOfId,
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
 *   - dragging is never the ONLY way to reorder. dnd-kit's KeyboardSensor
 *     handles space-then-arrows on the handle, and the ↑ ↓ buttons stay for
 *     everyone who never discovers that;
 *   - every move is announced, in Vietnamese, through dnd-kit's own live
 *     region for drags and a local one for the buttons.
 *
 * Reordering uses dnd-kit rather than hand-rolled pointer events: pointercancel,
 * auto-scroll and the keyboard model are each easy to get subtly wrong, and the
 * skill is explicit that this is not a thing to write from scratch.
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

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "Nhấn phím cách để bắt đầu di chuyển file. Dùng phím mũi tên lên xuống để đổi vị trí, " +
    "nhấn phím cách để thả, nhấn Escape để huỷ. File ở vị trí 1 là ảnh bìa.",
};

export function UploadPanel(props: UploadPanelProps) {
  const inputId = useId();
  const [isOver, setIsOver] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const { queue, onQueueChange, disabled } = props;
  const full = queue.length >= MAX_UPLOAD_FILES;

  const sensors = useSensors(
    // A small distance so a click on a row's button is not read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
    const moved = queue[from];
    onQueueChange(next);
    setAnnouncement(describeMove(moved.file.name, indexOfId(next, moved.id), next.length));
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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = indexOfId(queue, String(active.id));
    const to = indexOfId(queue, String(over.id));
    if (from < 0 || to < 0) return;

    // The same tested helper the buttons use — one definition of "move".
    onQueueChange(moveItem(queue, from, to));
  }

  /**
   * dnd-kit owns the live region during a drag; these are its words.
   *
   * Positions come from `sortable.index`, NOT from resolving `over.id` against
   * the queue: collision detection can name a neighbour before the pointer has
   * moved, which announced the wrong slot the moment a drag began.
   */
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Bắt đầu di chuyển ${nameOf(queue, active.id)}, đang ở vị trí ${sortableIndex(active) + 1} trên ${queue.length}.`,
    onDragOver: ({ active, over }) => {
      const to = sortableIndex(over);
      if (to < 0) return undefined;
      return `${nameOf(queue, active.id)} sẽ vào vị trí ${to + 1} trên ${queue.length}.`;
    },
    onDragEnd: ({ active, over }) => {
      const to = sortableIndex(over);
      if (to < 0) return `Đã thả ${nameOf(queue, active.id)} về chỗ cũ.`;
      return describeMove(nameOf(queue, active.id), to, queue.length);
    },
    onDragCancel: ({ active }) => `Đã huỷ, ${nameOf(queue, active.id)} về chỗ cũ.`,
  };

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

      {queue.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        >
          <SortableContext
            items={queue.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="divide-border divide-y rounded-lg border">
              {queue.map((item, index) => (
                <SortableRow
                  key={item.id}
                  item={item}
                  index={index}
                  total={queue.length}
                  disabled={disabled ?? false}
                  onMoveUp={() => move(index, index - 1)}
                  onMoveDown={() => move(index, index + 1)}
                  onCover={() => cover(index)}
                  onRemove={() => remove(index)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : null}

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

      {/* Adds, button-driven moves and removals. Drags are announced by dnd-kit
          in its own region, so the two never talk over each other. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

interface SortableRowProps {
  item: QueuedFile;
  index: number;
  total: number;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCover: () => void;
  onRemove: () => void;
}

function SortableRow(props: SortableRowProps) {
  const { item, index, total, disabled } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 p-3 ${isDragging ? "bg-muted relative z-10" : ""}`}
    >
      {/* A dedicated handle, not the whole row: the row holds four buttons, and
          a whole-row drag would swallow their clicks. */}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none px-1 disabled:cursor-not-allowed"
        disabled={disabled}
        aria-label={`Kéo để đổi vị trí ${item.file.name}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <span className="text-muted-foreground w-6 shrink-0 text-sm tabular-nums">{index + 1}</span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.file.name}</span>
        <span className="text-muted-foreground text-xs">{formatBytes(item.file.size)}</span>
      </span>

      {index === 0 ? <Badge>Ảnh bìa</Badge> : null}

      <span className="flex shrink-0 gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === 0}
          onClick={props.onMoveUp}
          aria-label={`Đưa ${item.file.name} lên trên`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === total - 1}
          onClick={props.onMoveDown}
          aria-label={`Đưa ${item.file.name} xuống dưới`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === 0}
          onClick={props.onCover}
        >
          Đặt làm bìa
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={props.onRemove}
          aria-label={`Bỏ ${item.file.name}`}
        >
          Bỏ
        </Button>
      </span>
    </li>
  );
}

function nameOf(queue: readonly QueuedFile[], id: string | number): string {
  return queue.find((item) => item.id === String(id))?.file.name ?? "file";
}

/** Authoritative position inside the SortableContext, or -1 when absent. */
function sortableIndex(entry: Active | Over | null | undefined): number {
  return hasSortableData(entry) ? entry.data.current.sortable.index : -1;
}
