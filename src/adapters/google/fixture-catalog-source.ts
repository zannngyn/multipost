import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AppError } from "@/core/domain/errors";
import type {
  DownloadDriveFileInput,
  DriveFile,
  DriveFileContent,
  DriveSource,
  ListDriveFilesInput,
} from "@/core/ports/drive-source";
import type { ReadSheetInput, SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { parseCsv as parseCsvText } from "@/shared/csv";

import { buildSheetSnapshot } from "./sheet-values";

/**
 * DriveSource/SheetSource backed by `sample-data/` — the real 5,497-file listing
 * and the real "Mẫu 2026" CSV export (docs/05).
 *
 * Why an adapter and not a test double: it is the only way to exercise the sync
 * end to end (DB included) until a Service Account exists, and it keeps the very
 * data docs/05 was measured on. It is dev/test only — never wired into a
 * production container.
 *
 * The listing file carries names only, so file ids and modifiedTime are
 * synthesised deterministically: later lines look "newer", which makes the
 * duplicate-name rule (newest wins) reproducible.
 */

const SAMPLE_DIR = "sample-data";
const LISTING_FILE = "drive-file-listing.txt";
const SHEET_FILE = "sheet-mau2026-snapshot-2026-08-12.csv";

/** The first lines of the listing are sub-folders, not files (docs/05 1.1). */
const SUBFOLDER_NAMES = new Set(["Hàng Thiết Kế", "Nghệ sĩ", "Ảnh hiển thị tiktok và shopee"]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function readSample(fileName: string, rootDir: string): string {
  const path = resolve(rootDir, SAMPLE_DIR, fileName);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new AppError("DRIVE_ERROR", {
      message: `Cannot read sample data file ${path}`,
      userMessage: "Không đọc được dữ liệu mẫu để chạy thử đồng bộ.",
      context: { path },
      cause: error,
    });
  }
}

export interface FixtureSourceOptions {
  /** Repo root; defaults to the process cwd (tests and scripts run from it). */
  readonly rootDir?: string;
}

/** Parses the raw listing into DriveFile values with stable ids. */
export function readFixtureDriveFiles(options: FixtureSourceOptions = {}): DriveFile[] {
  const text = readSample(LISTING_FILE, options.rootDir ?? process.cwd());
  const files: DriveFile[] = [];
  const base = Date.UTC(2026, 0, 1);

  text.split("\n").forEach((line, index) => {
    // Trailing whitespace is data here (97 real names start with tabs/spaces),
    // so only the line terminator is removed.
    const name = line.replace(/\r$/, "");
    if (name.trim().length === 0) return;
    if (SUBFOLDER_NAMES.has(name.trim())) return;

    const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim())?.[1]?.toLowerCase();
    files.push({
      id: `fixture-${index.toString().padStart(5, "0")}`,
      name,
      mimeType: (extension && MIME_BY_EXTENSION[extension]) ?? "application/octet-stream",
      sizeBytes: 100_000 + index,
      modifiedTime: new Date(base + index * 60_000).toISOString(),
    });
  });

  return files;
}

/**
 * 1x1 transparent PNG. `download` must return bytes a real image decoder (and
 * Facebook's fetcher) accepts, otherwise the fixture proves nothing about the
 * media route; padding keeps every file a different length.
 */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function makeFixtureDriveSource(options: FixtureSourceOptions = {}): DriveSource {
  let index: Map<string, DriveFile> | null = null;
  const byId = (): Map<string, DriveFile> => {
    index ??= new Map(readFixtureDriveFiles(options).map((file) => [file.id, file]));
    return index;
  };

  return {
    async listFiles(input: ListDriveFilesInput): Promise<readonly DriveFile[]> {
      const files = readFixtureDriveFiles(options);
      const max = input?.maxFiles && input.maxFiles > 0 ? input.maxFiles : files.length;
      return files.slice(0, max);
    },

    async download(input: DownloadDriveFileInput): Promise<DriveFileContent> {
      const fileId = typeof input?.fileId === "string" ? input.fileId.trim() : "";
      const file = fileId.length > 0 ? byId().get(fileId) : undefined;
      if (!file) {
        // Same verdict as the real adapter for a deleted/unshared file.
        throw new AppError("MEDIA_NOT_FOUND", {
          message: `Fixture Drive has no file with id ${fileId || "(empty)"}`,
          userMessage: "Không tìm thấy file ảnh trên Drive (dữ liệu mẫu).",
          context: {
            tenant_id: typeof input?.tenantId === "string" ? input.tenantId : null,
            drive_file_id: fileId || null,
          },
        });
      }

      // Same bytes for every file — the listing carries names only, so there is
      // no real content to serve. The mime type still follows the file name, so
      // a caller can see the extension-less files (docs/05 1.3) coming through.
      const bytes = new Uint8Array(Buffer.from(PNG_1X1_BASE64, "base64"));
      return { fileId, bytes, mimeType: file.mimeType ?? "image/png", sizeBytes: bytes.length };
    },
  };
}

export function readFixtureSheetSnapshot(options: FixtureSourceOptions = {}): SheetSnapshot {
  const text = readSample(SHEET_FILE, options.rootDir ?? process.cwd());
  return buildSheetSnapshot(parseCsv(text));
}

export function makeFixtureSheetSource(options: FixtureSourceOptions = {}): SheetSource {
  return {
    async readRows(_input: ReadSheetInput): Promise<SheetSnapshot> {
      return readFixtureSheetSnapshot(options);
    },
  };
}

/**
 * CSV reader for the sample export. The state machine lives in `@/shared/csv`
 * (written by hand — CLAUDE.md forbids a new dependency) so the fixture, the
 * uploaded-file adapter and any future format read a table the same way.
 * The delimiter is forced: this file is a known comma export, and a fixture
 * must not change shape because a detector changed its mind.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvText(text, { delimiter: "," }).rows.map((row) => [...row]);
}
