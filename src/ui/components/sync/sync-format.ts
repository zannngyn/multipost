/**
 * Formatting shared by the sync screen blocks. Kept in one file so the funnel,
 * the issue table and the rail never disagree about how a number or a timestamp
 * looks — an operator comparing two blocks must not have to translate.
 *
 * Every function is total: an unparsable timestamp is echoed back rather than
 * rendered as "Invalid Date".
 */

const COUNT_FORMAT = new Intl.NumberFormat("vi-VN");

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return COUNT_FORMAT.format(value);
}

/**
 * Share of `value` in `total`, ready to print. Three distinct answers, on
 * purpose:
 *   null    — `total <= 0`: nothing entered, so there is no share to speak of
 *   "0%"    — a real zero: this group/stage holds nothing
 *   "<1%"   — some rows, but under half a percent. Rounding those to "0%" next
 *             to a count of 30 reads as a broken cell, not as "very small".
 */
export function percentOf(value: number, total: number): string | null {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;

  const rounded = Math.round((value / total) * 100);
  if (rounded === 0 && value > 0) return "<1%";
  return `${rounded}%`;
}

/** Width of a bar segment, clamped so a bad count cannot overflow the track. */
export function segmentWidth(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0 || value <= 0) return "0%";
  return `${Math.min(100, (value / total) * 100)}%`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { timeStyle: "medium" }).format(date);
}

export function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  return `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`;
}
