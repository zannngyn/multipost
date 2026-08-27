/**
 * Pure half of the direct-to-storage upload path: decisions that must be
 * testable without a DOM or the network. Everything that touches `fetch`
 * lives in `@/ui/services/upload.api`.
 */

export interface UploadCandidate {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Claim sent to the ticket stage. Order is kept: index 0 is the cover. */
export function planUploadOrder(files: readonly File[]): UploadCandidate[] {
  return files.map((file) => ({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  }));
}

/** Percent done, clamped to 0..100. `total <= 0` is 0, never a division by zero. */
export function nextProgress(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.round((done / total) * 100);
  return Math.min(100, Math.max(0, ratio));
}
