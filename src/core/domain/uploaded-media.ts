import { AppError } from "@/core/domain/errors";
import { mediaKindFromMimeType, type MediaKind } from "@/core/domain/media-file-name";

/**
 * E9 (mode B) — the rules an operator-supplied file must satisfy before it is
 * stored. Pure: no filesystem, no I/O (docs/07 section 2).
 *
 * Mode A parses meaning OUT of the file name (`MÃ-Màu (số).ext`). Mode B does
 * the opposite: the operator dictates the album and its order by hand, so the
 * name carries no meaning and is kept only to show the file back to them.
 */

/**
 * Hard ceiling, and it is NOT arbitrary: every asset — photo AND video — reaches
 * the platform through the signed media bridge, which buffers the bytes in
 * memory (`getMediaContent`, DEFAULT_MAX_BYTES). Accepting a file above what the
 * bridge can serve would store something that can never publish, and the
 * operator would only find out at publish time (business rule 5).
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Brief section 4.2 caps an album at 10; the same ceiling applies to mode B. */
export const MAX_UPLOADS_PER_POST = 10;

/**
 * Deliberately a whitelist, not "anything image/*": SVG carries script, and HEIC
 * is rejected by Graph API, so both must fail here rather than at publish time.
 */
export const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
];

export type UploadRejectionReason =
  | "EMPTY_FILE_NAME"
  | "EMPTY_FILE"
  | "UNSUPPORTED_TYPE"
  | "TOO_LARGE";

export interface UploadCandidate {
  readonly fileName: string;
  /** Browser-declared content type. */
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface UploadRejection {
  readonly reason: UploadRejectionReason;
  /** Vietnamese, actionable — shown next to the offending file. */
  readonly userMessage: string;
}

export type UploadVerdict =
  | { readonly ok: true; readonly kind: MediaKind; readonly mimeType: string }
  | { readonly ok: false; readonly rejection: UploadRejection };

/**
 * The album kind comes from the declared MIME type only, never the extension:
 * two sources would let a `.jpg` holding an mp4 take the photo path and fail
 * deep inside Graph API instead of here.
 */
export function validateUpload(candidate: UploadCandidate): UploadVerdict {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const fileName = typeof candidate?.fileName === "string" ? candidate.fileName.trim() : "";
  if (fileName.length === 0) {
    return reject("EMPTY_FILE_NAME", "File không có tên — không nhận được file này.");
  }

  const sizeBytes = candidate?.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return reject("EMPTY_FILE", `File "${fileName}" rỗng hoặc hỏng — không nhận được.`);
  }

  const mimeType = normaliseMime(candidate?.mimeType);
  if (!mimeType || !ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType)) {
    return reject(
      "UNSUPPORTED_TYPE",
      `File "${fileName}" không thuộc định dạng được nhận (JPG, PNG, WEBP, MP4, MOV).`,
    );
  }

  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return reject(
      "TOO_LARGE",
      `File "${fileName}" nặng ${formatMb(sizeBytes)} — vượt mức tối đa ${formatMb(MAX_UPLOAD_BYTES)}.`,
    );
  }

  const kind = mediaKindFromMimeType(mimeType);
  if (!kind) {
    // Unreachable while the whitelist holds only image/* and video/*; kept so a
    // future entry cannot silently fall through without a kind.
    return reject("UNSUPPORTED_TYPE", `Không xác định được loại của file "${fileName}".`);
  }

  return { ok: true, kind, mimeType };
}

/**
 * Applies the operator's arrangement. `order` holds indexes into `items`, and
 * index 0 becomes the cover (brief section 8).
 *
 * Throws rather than repairing: a non-permutation means the client and the
 * server disagree about the album, and quietly publishing a different set of
 * photos than the one arranged on screen is exactly what business rule 5 bans.
 */
export function applyUploadOrder<T>(items: readonly T[], order: readonly number[] | undefined): T[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "An uploaded album must hold at least one file",
      userMessage: "Bài này chưa có file nào — hãy tải lên ít nhất một ảnh hoặc video.",
      context: { reason: "EMPTY_ALBUM" },
    });
  }

  if (items.length > MAX_UPLOADS_PER_POST) {
    throw new AppError("INVALID_INPUT", {
      message: `An uploaded album holds at most ${MAX_UPLOADS_PER_POST} files`,
      userMessage: `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file — hiện đang có ${items.length}.`,
      context: { reason: "TOO_MANY_FILES", count: items.length, max: MAX_UPLOADS_PER_POST },
    });
  }

  if (order === undefined || order === null) return [...items];

  if (!isPermutationOf(order, items.length)) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload order must be a permutation of the uploaded files",
      userMessage: "Thứ tự file gửi lên không khớp với danh sách file — hãy tải lại trang và thử lại.",
      context: { reason: "ORDER_NOT_PERMUTATION", order_length: order.length, count: items.length },
    });
  }

  return order.map((index) => items[index]);
}

// --- helpers ----------------------------------------------------------------

function reject(reason: UploadRejectionReason, userMessage: string): UploadVerdict {
  return { ok: false, rejection: { reason, userMessage } };
}

/** Drops `; charset=…` and lowercases, so `IMAGE/JPEG; x=y` matches the list. */
function normaliseMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length > 0 ? mime : null;
}

function isPermutationOf(order: readonly number[], length: number): boolean {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= length) return false;
    if (seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
