/**
 * Media strategy selector (E2/E3, onboarding phase 2).
 * Pure TypeScript: sibling domain modules only, no I/O (docs/07 section 2).
 *
 * ONE question: given this tenant's `MediaProfile`, which Drive file belongs to
 * which product code? Four answers (see media-profile.ts), one output shape.
 *
 * Everything it cannot answer comes back as a VALUE — `rejected` (the file was
 * dropped, somebody has to fix something) or `reviews` (the file WAS imported
 * but its attribution is a guess). Nothing is swallowed and nothing throws:
 * one unreadable file must never end a 5,500-file sync (business rule 5).
 *
 * It also enforces the one hard constraint the database has: `media_asset` is
 * unique on (tenant, drive_file_id), so a file claimed by two product codes
 * produces one asset and one visible issue — never two rows that fail on
 * insert.
 */

import { parseDriveMediaRefs } from "./google-source-ref";
import {
  findKnownCodes,
  isProductCode,
  mediaKindFromMimeType,
  normalizeProductCode,
  parseMediaFileName,
  type MediaFileName,
} from "./media-file-name";
import {
  resolveMediaProfile,
  type MediaProfile,
  type MediaProfileKind,
} from "./media-profile";
import type { MediaAsset } from "./product";

/**
 * The part of a Drive listing this resolver needs. Structural on purpose: the
 * port's `DriveFile` satisfies it, and `core/domain` stays free of `core/ports`.
 */
export interface MediaSourceFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string | null;
  readonly sizeBytes?: number | null;
  readonly modifiedTime?: string | null;
  /** Folder holding the file. Absent for a flat (non-recursive) listing. */
  readonly parentFolderId?: string | null;
  /**
   * Folder names from the configured root down to the parent, root EXCLUDED.
   * `[]` = the file sits directly in the configured folder.
   */
  readonly folderPath?: readonly string[];
}

/** One row's media link cell (`sheet-column` profile). */
export interface MediaLinkCell {
  readonly code: string;
  /** The cell exactly as the sheet wrote it; may hold several links. */
  readonly value: string;
}

export interface ResolveMediaInput {
  readonly files: readonly MediaSourceFile[];
  /** Absent = `code-color-seq`, the internal convention. */
  readonly profile?: MediaProfile | null;
  /** Product codes from the sheet — lets a code of ANY shape be recognised. */
  readonly knownCodes?: readonly string[];
  /** `sheet-column` only. Ignored by the other profiles. */
  readonly mediaLinks?: readonly MediaLinkCell[];
}

/** A machine reason + a sentence an operator can act on (Vietnamese). */
export interface MediaResolutionIssue {
  readonly reason: string;
  /** File name, product code or link — whatever identifies the subject. */
  readonly ref: string;
  readonly detail: string;
}

export interface ResolveMediaResult {
  /** The profile actually used (an unknown/absent one falls back to default). */
  readonly profileKind: MediaProfileKind;
  readonly assets: readonly MediaAsset[];
  /** Files that produced no asset. */
  readonly rejected: readonly MediaResolutionIssue[];
  /** Assets that WERE produced but rest on a guess. */
  readonly reviews: readonly MediaResolutionIssue[];
}

/** Longest folder name we will accept as a product code (a sentence is not one). */
const MAX_FOLDER_CODE_LENGTH = 64;

export function resolveMedia(input: ResolveMediaInput): ResolveMediaResult {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const profile = resolveMediaProfile(input?.profile);
  const files = Array.isArray(input?.files) ? input.files.filter(isUsableFile) : [];
  const knownCodes = normalizeKnownCodes(input?.knownCodes);
  const collector = new AssetCollector();

  if (files.length === 0) {
    // Not an error here: an empty folder is a fact. `syncCatalog` is the one
    // that refuses to delete a catalog over it.
    return collector.result(profile.kind);
  }

  switch (profile.kind) {
    case "sheet-column":
      resolveBySheetColumn(files, input?.mediaLinks, profile, collector);
      break;
    case "folder-per-code":
      resolveByFolder(files, knownCodes, profile, collector);
      break;
    default:
      resolveByFileName(files, knownCodes, profile, collector);
      break;
  }

  return collector.result(profile.kind);
}

// --- Strategy 1: the file name carries the code -----------------------------

function resolveByFileName(
  files: readonly MediaSourceFile[],
  knownCodes: ReadonlySet<string>,
  profile: MediaProfile,
  collector: AssetCollector,
): void {
  for (const file of files) {
    const parsed = parseMediaFileName(file.name, profile, { knownCodes });
    if (!parsed.ok) {
      collector.reject({ reason: parsed.issue, ref: file.name, detail: parsed.detail });
      continue;
    }
    collector.add(file, parsed.value);
  }
}

// --- Strategy 2: the FOLDER carries the code --------------------------------

interface FolderCode {
  readonly code: string;
  /** `known` = it is a code of the sheet; `pattern` = it looks like one. */
  readonly source: "known" | "pattern" | "folder-name";
}

function resolveByFolder(
  files: readonly MediaSourceFile[],
  knownCodes: ReadonlySet<string>,
  profile: MediaProfile,
  collector: AssetCollector,
): void {
  const codeByFolder = new Map<string, FolderCode | null>();
  const reportedFolders = new Set<string>();

  for (const file of files) {
    // The FIRST segment is the code folder: deeper levels group variants
    // ("MG0AD6112/ảnh thật/"), they do not rename the product.
    const folderName = firstFolderName(file);
    if (folderName === null) {
      collector.reject({
        reason: "NO_FOLDER_CODE",
        ref: file.name,
        detail:
          "File nằm ngay thư mục gốc chứ không nằm trong thư mục mang tên mã sản phẩm — chuyển vào đúng thư mục mã rồi đồng bộ lại.",
      });
      continue;
    }

    let folderCode = codeByFolder.get(folderName);
    if (folderCode === undefined) {
      folderCode = codeFromFolderName(folderName, knownCodes);
      codeByFolder.set(folderName, folderCode);
    }
    if (folderCode === null) {
      if (!reportedFolders.has(folderName)) {
        reportedFolders.add(folderName);
        collector.reject({
          reason: "NO_FOLDER_CODE",
          ref: folderName,
          detail: `Tên thư mục '${folderName}' không dùng làm mã sản phẩm được — đổi tên thư mục thành đúng mã rồi đồng bộ lại.`,
        });
      }
      continue;
    }

    if (folderCode.source === "folder-name" && !reportedFolders.has(folderName)) {
      reportedFolders.add(folderName);
      // Reported ONCE per folder, not per file: a mismatching folder must be
      // visible without drowning the issue list.
      collector.review({
        reason: "CODE_FROM_FOLDER_NAME",
        ref: folderName,
        detail: `Thư mục '${folderName}' không khớp mã nào trên bảng tính; hệ thống tạm coi tên thư mục là mã. Kiểm tra lại tên thư mục hoặc thêm dòng vào bảng tính.`,
      });
    }

    // The name still contributes colour/sequence when it happens to carry them.
    const parsed = parseMediaFileName(file.name, profile, {
      knownCodes,
      productCode: folderCode.code,
    });
    if (!parsed.ok) {
      collector.reject({ reason: parsed.issue, ref: file.name, detail: parsed.detail });
      continue;
    }
    collector.add(file, parsed.value);
  }
}

/** `[]`/absent folderPath = the configured root, which carries no code. */
function firstFolderName(file: MediaSourceFile): string | null {
  const path = Array.isArray(file.folderPath) ? file.folderPath : [];
  const first = path.find((segment) => typeof segment === "string" && segment.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Folder name -> product code, three tries, most trustworthy first.
 * Returns null when the name cannot carry a code at all.
 */
export function codeFromFolderName(
  folderName: string,
  knownCodes: ReadonlySet<string>,
): FolderCode | null {
  const trimmed = typeof folderName === "string" ? folderName.trim() : "";
  if (trimmed.length === 0) return null;

  const upper = normalizeProductCode(trimmed);
  if (knownCodes.has(upper)) return { code: upper, source: "known" };

  // "MG0AD6112 - Váy hoa nhí" — the tenant's own code inside a longer name.
  const inside = findKnownCodes(upper, knownCodes);
  if (inside.length > 0) return { code: inside[0].code, source: "known" };

  const token = upper
    .split(/[^A-Z0-9]+/)
    .find((candidate) => isProductCode(candidate));
  if (token) return { code: token, source: "pattern" };

  // Last resort: the folder name IS the code. Flagged by the caller, because a
  // folder called "Ảnh mẫu 2026" would silently invent a product otherwise.
  if (upper.length > MAX_FOLDER_CODE_LENGTH) return null;
  return { code: upper, source: "folder-name" };
}

// --- Strategy 3: a sheet column carries the link ----------------------------

function resolveBySheetColumn(
  files: readonly MediaSourceFile[],
  mediaLinks: readonly MediaLinkCell[] | undefined,
  profile: MediaProfile,
  collector: AssetCollector,
): void {
  const cells = Array.isArray(mediaLinks) ? mediaLinks : [];
  if (cells.length === 0) {
    // Configuration problem, not a data problem — one issue, not 5,500.
    collector.reject({
      reason: "MEDIA_LINK_COLUMN_EMPTY",
      ref: "mediaLink",
      detail:
        "Chưa có dòng nào trên bảng tính chứa link ảnh — kiểm tra lại cột link ảnh đã khai báo, hoặc đổi sang cách nhận ảnh khác.",
    });
    return;
  }

  const byId = new Map<string, MediaSourceFile>();
  const byParent = new Map<string, MediaSourceFile[]>();
  for (const file of files) {
    byId.set(file.id, file);
    const parent = typeof file.parentFolderId === "string" ? file.parentFolderId : null;
    if (parent === null) continue;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(file);
    else byParent.set(parent, [file]);
  }

  const used = new Set<string>();
  for (const cell of cells) {
    const code = normalizeProductCode(cell?.code ?? "");
    if (code.length === 0) continue;

    const refs = parseDriveMediaRefs(cell?.value);
    if (refs.length === 0) {
      const raw = typeof cell?.value === "string" ? cell.value.trim() : "";
      collector.reject({
        reason: raw.length === 0 ? "MEDIA_LINK_MISSING" : "MEDIA_LINK_INVALID",
        ref: code,
        detail:
          raw.length === 0
            ? "Dòng này chưa điền link ảnh — dán link file/thư mục Drive vào cột link ảnh rồi đồng bộ lại."
            : `Ô link ảnh của mã này không chứa link Drive nào đọc được ('${truncate(raw)}') — dán lại link file hoặc thư mục Drive.`,
      });
      continue;
    }

    for (const ref of refs) {
      const direct = byId.get(ref.id);
      const inFolder = byParent.get(ref.id) ?? [];
      const targets = direct ? [direct] : inFolder;
      if (targets.length === 0) {
        // The id is fine, it just is not inside the folder this tenant synced.
        // KNOWN LIMIT: resolving it would mean one Drive call per row.
        collector.reject({
          reason: "MEDIA_LINK_NOT_IN_FOLDER",
          ref: `${code} -> ${ref.id}`,
          detail:
            "Link ảnh trỏ tới file/thư mục nằm ngoài thư mục Drive đã khai báo — di chuyển ảnh vào thư mục đó, hoặc khai lại thư mục gốc cho đúng.",
        });
        continue;
      }

      for (const file of targets) {
        if (used.has(file.id)) {
          // (tenant, drive_file_id) is unique: the first code keeps the file.
          collector.review({
            reason: "MEDIA_LINK_SHARED",
            ref: `${code} -> ${file.name}`,
            detail: `File '${file.name}' đang được nhiều mã cùng trỏ tới; hệ thống chỉ gán cho mã đầu tiên. Nhân bản ảnh nếu thật sự dùng cho nhiều mã.`,
          });
          continue;
        }
        used.add(file.id);
        // No file-name parsing at all: this profile exists precisely for
        // tenants whose file names say nothing. Colour comes from nowhere, so
        // the album is simply not split by colour.
        const parsed = parseMediaFileName(file.name, profile, { productCode: code });
        if (!parsed.ok) {
          collector.reject({ reason: parsed.issue, ref: file.name, detail: parsed.detail });
          continue;
        }
        collector.add(file, parsed.value);
      }
    }
  }

  const unused = files.filter((file) => !used.has(file.id)).length;
  if (unused > 0) {
    collector.review({
      reason: "FILES_NOT_LINKED",
      ref: String(unused),
      detail: `${unused} file trong thư mục Drive không được dòng nào trỏ tới nên không được dùng — thêm link vào cột link ảnh nếu cần dùng chúng.`,
    });
  }
}

// --- Shared -----------------------------------------------------------------

class AssetCollector {
  private readonly assets: MediaAsset[] = [];
  private readonly byFileId = new Map<string, MediaAsset>();
  private readonly rejected: MediaResolutionIssue[] = [];
  private readonly reviews: MediaResolutionIssue[] = [];

  add(file: MediaSourceFile, name: MediaFileName): void {
    const existing = this.byFileId.get(file.id);
    if (existing) {
      // A file with two parents comes back twice from a recursive listing —
      // same code, nothing to report. Two DIFFERENT codes is a real conflict:
      // (tenant, drive_file_id) is unique, so the first one keeps the file.
      if (existing.productCode !== name.productCode) {
        this.review({
          reason: "DUPLICATE_DRIVE_FILE_ID",
          ref: file.name,
          detail: `Cùng một file Drive được gán cho hai mã (${existing.productCode} và ${name.productCode}); hệ thống giữ mã đầu tiên.`,
        });
      }
      return;
    }

    // The extension decides the kind; when there is none (606 real files) the
    // Drive mime type is the fallback, and the asset is flagged for confirmation.
    const kind =
      name.extension !== null ? name.kind : (mediaKindFromMimeType(file.mimeType) ?? name.kind);

    const asset: MediaAsset = {
      driveFileId: file.id,
      origin: "drive",
      storageKey: null,
      fileName: name.normalized,
      productCode: name.productCode,
      color: name.color,
      colorRaw: name.colorRaw,
      sequence: name.sequence,
      kind,
      variants: name.variants,
      mimeType: file.mimeType ?? null,
      sizeBytes: file.sizeBytes ?? null,
      modifiedTime: file.modifiedTime ?? null,
      warnings: name.warnings,
      needsReview: !name.isStrict,
    };
    this.byFileId.set(file.id, asset);
    this.assets.push(asset);

    // Outfit-set photos stay usable but must be visible on the review list.
    if (name.otherProductCodes.length > 0) {
      this.review({
        reason: "MULTIPLE_PRODUCT_CODES",
        ref: file.name,
        detail: `Tên file có nhiều mã sản phẩm; hệ thống gán file này cho ${name.productCode} (mã đứng đầu tên). Các mã còn lại: ${name.otherProductCodes.join(", ")}. Kiểm tra lại nếu ảnh thuộc mã khác.`,
      });
    }
  }

  reject(issue: MediaResolutionIssue): void {
    this.rejected.push(issue);
  }

  review(issue: MediaResolutionIssue): void {
    this.reviews.push(issue);
  }

  result(profileKind: MediaProfileKind): ResolveMediaResult {
    return {
      profileKind,
      assets: this.assets,
      rejected: this.rejected,
      reviews: this.reviews,
    };
  }
}

function isUsableFile(file: MediaSourceFile | null | undefined): file is MediaSourceFile {
  return (
    !!file &&
    typeof file.id === "string" &&
    file.id.length > 0 &&
    typeof file.name === "string" &&
    file.name.length > 0
  );
}

function normalizeKnownCodes(codes: readonly string[] | undefined): ReadonlySet<string> {
  if (!Array.isArray(codes)) return new Set<string>();
  const set = new Set<string>();
  for (const code of codes) {
    const normalized = normalizeProductCode(typeof code === "string" ? code : "");
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
