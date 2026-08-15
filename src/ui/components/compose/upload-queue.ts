/**
 * E9.2 — the ordering rules of the mode B file list, kept free of React so they
 * can be tested in the node environment the project already uses (same reason
 * as `shell/nav-items`).
 *
 * The list IS the album: index 0 is the cover (brief §8), and the order sent to
 * the server is the order shown on screen.
 */

export interface QueuedFile {
  /** Stable across reorders — a File object is not a reliable React key. */
  readonly id: string;
  readonly file: File;
}

/** Moves one entry, clamping rather than throwing: the caller is a button. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const list = [...items];
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;

  const target = Math.min(Math.max(to, 0), list.length - 1);
  if (target === from) return list;

  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  return list;
}

/** Promotes one entry to the front — "đặt làm ảnh bìa". */
export function makeCover<T>(items: readonly T[], index: number): T[] {
  return moveItem(items, index, 0);
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return [...items];
  return items.filter((_item, position) => position !== index);
}

/**
 * What the screen reader announces after a move. Spelled out because a silent
 * reorder is invisible to anyone not looking at the list (web-drag-drop-reorder
 * rule 6).
 */
export function describeMove(fileName: string, position: number, total: number): string {
  const place = position === 0 ? "vị trí 1, ảnh bìa" : `vị trí ${position + 1}`;
  return `${fileName} chuyển tới ${place} trên tổng ${total} file.`;
}

/** Human size for a message that must name the limit, not just "too big". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
