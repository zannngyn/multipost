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
import type { ReactNode } from "react";
import { useState } from "react";

import { describeMove, indexOfId, makeCover, moveItem } from "@/ui/components/compose/upload-queue";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";

/**
 * One implementation of "arrange an album", shared by both file modes (brief
 * §8). Mode A gathers from Drive and mode B from the operator's machine, but
 * the gesture afterwards is identical: the list IS the album, index 0 is the
 * cover, and the order shown is the order published.
 *
 * Accessibility (web-drag-drop-reorder):
 *   - dragging is never the only way. dnd-kit's KeyboardSensor handles
 *     space-then-arrows on the handle, and the ↑ ↓ buttons stay for everyone
 *     who never discovers that;
 *   - the handle is its own control, not the whole row, because rows carry
 *     buttons a row-wide drag would swallow;
 *   - positions in announcements come from `sortable.index`, never from
 *     resolving `over.id` against the list: collision detection names a
 *     neighbour before the pointer moves, which announces the wrong slot the
 *     instant a drag begins.
 */

export interface AlbumEntry {
  readonly id: string;
}

export interface AlbumArrangerProps<T extends AlbumEntry> {
  items: readonly T[];
  onChange: (next: T[]) => void;
  /** Name used in aria-labels and announcements. */
  itemName: (item: T) => string;
  /** Main line of a row. */
  renderContent: (item: T, index: number) => ReactNode;
  /** Optional trailing controls, e.g. "Bỏ" in the upload panel. */
  renderActions?: (item: T, index: number) => ReactNode;
  disabled?: boolean;
  /**
   * A one-clip video post has nothing to arrange, and "ảnh bìa" would be
   * nonsense — the caller says so and the list renders read-only.
   */
  readOnly?: boolean;
  coverLabel?: string;
}

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "Nhấn phím cách để bắt đầu di chuyển. Dùng phím mũi tên lên xuống để đổi vị trí, " +
    "nhấn phím cách để thả, nhấn Escape để huỷ. Mục ở vị trí 1 là ảnh bìa.",
};

export function AlbumArranger<T extends AlbumEntry>(props: AlbumArrangerProps<T>) {
  const { items, onChange, itemName, disabled = false, readOnly = false } = props;
  const coverLabel = props.coverLabel ?? "Ảnh bìa";
  const [announcement, setAnnouncement] = useState("");

  const sensors = useSensors(
    // A small distance so a click on a row's button is not read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function move(from: number, to: number) {
    const next = moveItem(items, from, to);
    if (next === items) return;
    const moved = items[from];
    onChange(next);
    setAnnouncement(describeMove(itemName(moved), indexOfId(next, moved.id), next.length));
  }

  function cover(index: number) {
    const next = makeCover(items, index);
    onChange(next);
    setAnnouncement(describeMove(itemName(items[index]), 0, next.length));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = indexOfId(items, String(active.id));
    const to = indexOfId(items, String(over.id));
    if (from < 0 || to < 0) return;

    // The same tested helper the buttons use — one definition of "move".
    onChange(moveItem(items, from, to));
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Bắt đầu di chuyển ${nameOf(items, itemName, active.id)}, đang ở vị trí ${sortableIndex(active) + 1} trên ${items.length}.`,
    onDragOver: ({ active, over }) => {
      const to = sortableIndex(over);
      if (to < 0) return undefined;
      return `${nameOf(items, itemName, active.id)} sẽ vào vị trí ${to + 1} trên ${items.length}.`;
    },
    onDragEnd: ({ active, over }) => {
      const to = sortableIndex(over);
      if (to < 0) return `Đã thả ${nameOf(items, itemName, active.id)} về chỗ cũ.`;
      return describeMove(nameOf(items, itemName, active.id), to, items.length);
    },
    onDragCancel: ({ active }) =>
      `Đã huỷ, ${nameOf(items, itemName, active.id)} về chỗ cũ.`,
  };

  if (items.length === 0) return null;

  // Read-only: no DndContext at all, so nothing announces or grabs a pointer.
  if (readOnly) {
    return (
      <ol className="divide-border divide-y rounded-lg border">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-center gap-3 p-3">
            <span className="text-muted-foreground w-6 shrink-0 text-sm tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">{props.renderContent(item, index)}</span>
            {index === 0 ? <Badge tone="success">{coverLabel}</Badge> : null}
            {props.renderActions?.(item, index)}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
      >
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="divide-border divide-y rounded-lg border">
            {items.map((item, index) => (
              <SortableRow
                key={item.id}
                id={item.id}
                name={itemName(item)}
                index={index}
                total={items.length}
                disabled={disabled}
                coverLabel={coverLabel}
                content={props.renderContent(item, index)}
                actions={props.renderActions?.(item, index)}
                onMoveUp={() => move(index, index - 1)}
                onMoveDown={() => move(index, index + 1)}
                onCover={() => cover(index)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      {/* Button-driven moves. Drags are announced by dnd-kit in its own region,
          so the two never talk over each other. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

interface SortableRowProps {
  id: string;
  name: string;
  index: number;
  total: number;
  disabled: boolean;
  coverLabel: string;
  content: ReactNode;
  actions: ReactNode;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCover: () => void;
}

function SortableRow(props: SortableRowProps) {
  const { id, name, index, total, disabled, coverLabel } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 p-3 ${isDragging ? "bg-muted relative z-10" : ""}`}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none px-1 disabled:cursor-not-allowed"
        disabled={disabled}
        aria-label={`Kéo để đổi vị trí ${name}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <span className="text-muted-foreground w-6 shrink-0 text-sm tabular-nums">{index + 1}</span>

      <span className="min-w-0 flex-1">{props.content}</span>

      {index === 0 ? <Badge tone="success">{coverLabel}</Badge> : null}

      <span className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === 0}
          onClick={props.onMoveUp}
          aria-label={`Đưa ${name} lên trên`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === total - 1}
          onClick={props.onMoveDown}
          aria-label={`Đưa ${name} xuống dưới`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || index === 0}
          onClick={props.onCover}
          aria-label={`Đặt ${name} làm ảnh bìa`}
        >
          Đặt làm bìa
        </Button>
        {props.actions}
      </span>
    </li>
  );
}

function nameOf<T extends AlbumEntry>(
  items: readonly T[],
  itemName: (item: T) => string,
  id: string | number,
): string {
  const found = items.find((item) => item.id === String(id));
  return found ? itemName(found) : "mục";
}

/** Authoritative position inside the SortableContext, or -1 when absent. */
function sortableIndex(entry: Active | Over | null | undefined): number {
  return hasSortableData(entry) ? entry.data.current.sortable.index : -1;
}
