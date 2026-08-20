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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { useState } from "react";

import { cn } from "@/shared/utils";
import { describeMove, indexOfId, makeCover, moveItem } from "@/ui/components/compose/upload-queue";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";

/**
 * One implementation of "arrange an album", shared by both file modes (brief
 * §8). Mode A gathers from Drive and mode B from the operator's machine, but
 * the gesture afterwards is identical: the list IS the album, index 0 is the
 * cover, and the order shown is the order published.
 *
 * Two layouts, one behaviour:
 *   - `list` — rows, used by the upload queue where filenames and per-file
 *     errors are the point;
 *   - `grid` — a large cover tile beside a grid of squares, used by the compose
 *     steps where the album's SHAPE is the point.
 * Only the presentation differs; the sorting, the announcements and the keyboard
 * path are the same code in both.
 *
 * Accessibility (web-drag-drop-reorder):
 *   - dragging is never the only way. dnd-kit's KeyboardSensor handles
 *     space-then-arrows on the handle, and the ↑ ↓ buttons stay for everyone
 *     who never discovers that;
 *   - the handle is its own control, not the whole tile, because tiles carry
 *     buttons a tile-wide drag would swallow;
 *   - positions in announcements come from `sortable.index`, never from
 *     resolving `over.id` against the list: collision detection names a
 *     neighbour before the pointer moves, which announces the wrong slot the
 *     instant a drag begins.
 *
 * HTML5 drag-and-drop is deliberately NOT used here: it does not fire on touch,
 * cannot be styled, and has no keyboard model (web-drag-drop-reorder §1).
 */

export interface AlbumEntry {
  readonly id: string;
}

export interface AlbumArrangerProps<T extends AlbumEntry> {
  items: readonly T[];
  onChange: (next: T[]) => void;
  /** Name used in aria-labels and announcements. */
  itemName: (item: T) => string;
  /** Main line of a row, and of the cover tile in `grid`. */
  renderContent: (item: T, index: number) => ReactNode;
  /** Shorter line for the small tiles of `grid`. Falls back to `renderContent`. */
  renderCompact?: (item: T, index: number) => ReactNode;
  /** Optional trailing controls, e.g. "Bỏ" in the upload panel. `list` only. */
  renderActions?: (item: T, index: number) => ReactNode;
  /**
   * The picture itself, drawn as the tile's background. `grid` only.
   * Absent = the tile stays a labelled empty surface (a one-clip video post, or
   * a caller with nothing to show).
   */
  renderMedia?: (item: T, index: number) => ReactNode;
  /**
   * Drops an item from the album. `grid` only, and absent = not removable.
   * The last item is never removable — an album of zero cannot be published.
   */
  onRemove?: (index: number) => void;
  disabled?: boolean;
  /**
   * A one-clip video post has nothing to arrange, and "ảnh bìa" would be
   * nonsense — the caller says so and the list renders read-only.
   */
  readOnly?: boolean;
  coverLabel?: string;
  layout?: "list" | "grid";
  /** Centred note on the cover tile, e.g. why no picture is shown. `grid` only. */
  coverNote?: string;
}

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "Nhấn phím cách để bắt đầu di chuyển. Dùng phím mũi tên để đổi vị trí, " +
    "nhấn phím cách để thả, nhấn Escape để huỷ. Mục ở vị trí 1 là ảnh bìa.",
};

export function AlbumArranger<T extends AlbumEntry>(props: AlbumArrangerProps<T>) {
  const { items, onChange, itemName, disabled = false, readOnly = false } = props;
  const coverLabel = props.coverLabel ?? "Ảnh bìa";
  const layout = props.layout ?? "list";
  const compact = props.renderCompact ?? props.renderContent;
  const [announcement, setAnnouncement] = useState("");

  const sensors = useSensors(
    // A small distance so a click on a tile's button is not read as a drag.
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

  /**
   * Removing is announced like a move is: the list shrank and the numbering
   * shifted, and a keyboard user has no other way to find that out.
   */
  function remove(index: number) {
    const dropped = items[index];
    if (!dropped || !props.onRemove) return;
    props.onRemove(index);
    setAnnouncement(`Đã bỏ ${itemName(dropped)} khỏi bài. Còn ${items.length - 1} mục.`);
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
    onDragCancel: ({ active }) => `Đã huỷ, ${nameOf(items, itemName, active.id)} về chỗ cũ.`,
  };

  if (items.length === 0) return null;

  // Read-only: no DndContext at all, so nothing announces or grabs a pointer.
  if (readOnly) {
    if (layout === "grid") {
      return (
        <GridFrame>
          {items.map((item, index) =>
            index === 0 ? (
              <TileShell
                key={item.id}
                isCover
                ordinal={1}
                coverLabel={coverLabel}
                coverNote={props.coverNote}
                media={props.renderMedia?.(item, 0)}
              >
                {props.renderContent(item, 0)}
              </TileShell>
            ) : (
              <TileShell key={item.id} ordinal={index + 1} media={props.renderMedia?.(item, index)}>
                {compact(item, index)}
              </TileShell>
            ),
          )}
        </GridFrame>
      );
    }

    return (
      <ol className="divide-border border-border divide-y rounded-xl border">
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

  const sortable = items.map((item, index) => ({
    key: item.id,
    id: item.id,
    name: itemName(item),
    index,
    total: items.length,
    disabled,
    onMoveUp: () => move(index, index - 1),
    onMoveDown: () => move(index, index + 1),
    onCover: () => cover(index),
    // An album of zero cannot be published, so the last item stays put.
    onRemove: props.onRemove && items.length > 1 ? () => remove(index) : undefined,
  }));

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
          strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}
        >
          {layout === "grid" ? (
            <GridFrame>
              {sortable.map((entry, index) => (
                <SortableTile
                  {...entry}
                  key={entry.key}
                  isCover={index === 0}
                  coverLabel={coverLabel}
                  coverNote={props.coverNote}
                  media={props.renderMedia?.(items[index], index)}
                >
                  {index === 0
                    ? props.renderContent(items[0], 0)
                    : compact(items[index], index)}
                </SortableTile>
              ))}
            </GridFrame>
          ) : (
            <ol className="divide-border border-border divide-y rounded-xl border">
              {sortable.map((entry, index) => (
                <SortableRow
                  {...entry}
                  key={entry.key}
                  coverLabel={coverLabel}
                  content={props.renderContent(items[index], index)}
                  actions={props.renderActions?.(items[index], index)}
                />
              ))}
            </ol>
          )}
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

/**
 * Cover beside the rest, as ONE flat ordered list.
 *
 * The cover is a cell that spans 2×2 rather than a separate container: nesting a
 * second <ol> inside the first would make a screen reader announce an album of
 * ten photos as a list of two, and "vị trí 4 trên 10" in the announcements
 * would no longer match anything on screen.
 */
function GridFrame({ children }: { children: ReactNode }) {
  return <ol className="grid list-none grid-cols-2 gap-2.5 @2xl:grid-cols-5">{children}</ol>;
}

interface TileShellProps {
  isCover?: boolean;
  ordinal: number;
  coverLabel?: string;
  coverNote?: string;
  children: ReactNode;
  /** The picture, drawn behind everything else. Absent = empty surface. */
  media?: ReactNode;
  /** Drag affordances; absent in the read-only album. */
  handle?: ReactNode;
  controls?: ReactNode;
  /** Worded actions along the bottom bar ("Đặt làm bìa", "Bỏ"). */
  actions?: ReactNode;
  isDragging?: boolean;
  innerRef?: (node: HTMLElement | null) => void;
  style?: React.CSSProperties;
}

/**
 * The visual tile: the photo, with the album's facts written over it.
 *
 * The tinted surface stays underneath the picture rather than being replaced by
 * it — it is what the operator sees while the bytes are in flight, and what
 * stays there if they never arrive. Nothing about the box depends on the image,
 * so a slow or missing photo cannot move the layout (CLS = 0).
 *
 * The cover spans 2×2 cells, which makes it exactly square next to square tiles
 * without needing a fixed pixel size — the grid stays fluid.
 */
function TileShell({
  isCover = false,
  ordinal,
  coverLabel,
  coverNote,
  children,
  media,
  handle,
  controls,
  actions,
  isDragging = false,
  innerRef,
  style,
}: TileShellProps) {
  return (
    <li
      ref={innerRef}
      style={style}
      className={cn(
        "border-border relative flex aspect-square flex-col justify-end overflow-hidden rounded-xl border",
        isCover ? "bg-media-empty-cover col-span-2 row-span-2" : "bg-media-empty",
        isDragging && "z-10 opacity-40",
      )}
    >
      {media}

      <span className="absolute top-2.5 left-2.5 z-1 flex items-center gap-1.5">
        {isCover ? (
          <span className="bg-accent text-accent-foreground rounded-full px-2.5 py-1 text-xs font-semibold">
            {coverLabel} · 1
          </span>
        ) : (
          <span className="bg-card/90 text-foreground-subtle flex size-5 items-center justify-center rounded-md font-mono text-xs tabular-nums">
            {ordinal}
          </span>
        )}
      </span>

      {handle || controls ? (
        <span className="absolute top-2 right-2 z-1 flex items-center gap-0.5">
          {handle}
          {controls}
        </span>
      ) : null}

      {/* Only when nothing is drawn behind: with a photo on the tile, a centred
          note would sit on top of the very thing it is explaining. */}
      {isCover && coverNote && !media ? (
        <span className="text-foreground-subtle absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center font-mono text-xs">
          {coverNote}
        </span>
      ) : null}

      <span
        className={cn(
          "bg-card/90 relative z-1 flex flex-col gap-1.5 backdrop-blur-sm",
          isCover ? "p-3" : "px-2 py-1.5",
        )}
      >
        {children}
        {actions ? <span className="flex flex-wrap items-center gap-1">{actions}</span> : null}
      </span>
    </li>
  );
}

interface SortableEntry {
  id: string;
  name: string;
  index: number;
  total: number;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCover: () => void;
  /** Absent = this album may not shrink any further. */
  onRemove?: () => void;
}

function SortableTile(
  props: SortableEntry & {
    isCover?: boolean;
    coverLabel?: string;
    coverNote?: string;
    media?: ReactNode;
    children: ReactNode;
  },
) {
  const { id, name, index, total, disabled, isCover, coverLabel } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  return (
    <TileShell
      isCover={isCover}
      coverLabel={coverLabel}
      coverNote={props.coverNote}
      media={props.media}
      ordinal={index + 1}
      isDragging={isDragging}
      innerRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      handle={
        <button
          type="button"
          className="bg-card/90 text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-6 cursor-grab touch-none items-center justify-center rounded-md text-xs outline-none focus-visible:ring-3 disabled:cursor-not-allowed"
          disabled={disabled}
          aria-label={`Kéo để đổi vị trí ${name}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      }
      controls={
        <>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="bg-card/90"
            disabled={disabled || index === 0}
            onClick={props.onMoveUp}
            aria-label={`Đưa ${name} lên trước`}
          >
            ←
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="bg-card/90"
            disabled={disabled || index === total - 1}
            onClick={props.onMoveDown}
            aria-label={`Đưa ${name} ra sau`}
          >
            →
          </Button>
        </>
      }
      actions={
        <>
          {!isCover ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={props.onCover}
              aria-label={`Đặt ${name} làm ${coverLabel?.toLowerCase() ?? "ảnh bìa"}`}
            >
              Đặt làm bìa
            </Button>
          ) : null}
          {props.onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={props.onRemove}
              aria-label={`Bỏ ${name} khỏi bài`}
            >
              Bỏ
            </Button>
          ) : null}
        </>
      }
    >
      {props.children}
    </TileShell>
  );
}

function SortableRow(
  props: SortableEntry & { coverLabel: string; content: ReactNode; actions: ReactNode },
) {
  const { id, name, index, total, disabled, coverLabel } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-3 p-3", isDragging && "bg-muted relative z-10")}
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
