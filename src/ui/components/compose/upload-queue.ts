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

/**
 * Position of an entry by id. dnd-kit identifies rows by id, not by index, so
 * every drag has to translate one into the other — and doing it in one place
 * keeps that translation testable.
 */
export function indexOfId(items: readonly { id: string }[], id: string): number {
  return items.findIndex((item) => item.id === id);
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

/**
 * An image can be shown from the File itself; a video cannot — grabbing its
 * first frame needs a <video> + canvas, and that is Phase 2 work. Returns
 * `false` instead of throwing: the caller is a component mid-render.
 */
export function isPreviewable(file: File): boolean {
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  return type.startsWith("image/");
}

/**
 * Reconciles the preview-URL map against the current queue, without creating
 * any React state or DOM API call itself — `createUrl` is injected so this
 * stays testable in the node environment, no jsdom required.
 *
 * MUST be idempotent: calling it twice in a row with the same `queue` and the
 * same `current` map returns a `next` map with the exact same URLs (no new
 * `createUrl` calls) and an empty `revoked` list. That property is what makes
 * StrictMode's setup→cleanup→setup double-invoke harmless — the second setup
 * sees nothing changed and does nothing.
 */
export function syncPreviewUrls(
  current: ReadonlyMap<string, string>,
  queue: readonly QueuedFile[],
  createUrl: (file: File) => string,
): { next: Map<string, string>; revoked: string[] } {
  const next = new Map<string, string>();
  const liveIds = new Set<string>();

  for (const item of queue) {
    liveIds.add(item.id);
    const existing = current.get(item.id);
    if (existing) {
      next.set(item.id, existing);
    } else if (isPreviewable(item.file)) {
      next.set(item.id, createUrl(item.file));
    }
  }

  const revoked: string[] = [];
  for (const [id, url] of current) {
    if (!liveIds.has(id)) revoked.push(url);
  }

  return { next, revoked };
}
