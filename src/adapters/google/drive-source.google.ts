import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type {
  DownloadDriveFileInput,
  DriveFile,
  DriveFileContent,
  DriveSource,
  ListDriveFilesInput,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import type { GoogleAuthClient } from "./service-account";

/**
 * Drive implementation of DriveSource (E2).
 * Everything Google returns is parsed through a schema before it becomes a
 * domain value: an entry without an id or a name is dropped here with a log
 * line, never handed upward as a half-built asset (technical rule 2).
 */

const FOLDER_MIME = "application/vnd.google-apps.folder";
const PAGE_SIZE = 1000;
/** Guard against an accidental full-Drive crawl: the real folder holds ~5,500. */
const DEFAULT_MAX_FILES = 20000;

const DriveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1).nullish(),
  /** Drive returns size as a decimal string, and omits it for some types. */
  size: z.string().nullish(),
  modifiedTime: z.string().nullish(),
});

const DriveListResponseSchema = z.object({
  files: z.array(z.unknown()).nullish(),
  nextPageToken: z.string().nullish(),
  incompleteSearch: z.boolean().nullish(),
});

export interface GoogleDriveSourceDeps {
  auth: GoogleAuthClient;
  logger: Logger;
}

export function makeGoogleDriveSource(deps: GoogleDriveSourceDeps): DriveSource {
  const drive = google.drive({ version: "v3", auth: deps.auth });

  return {
    async listFiles(input: ListDriveFilesInput): Promise<readonly DriveFile[]> {
      // --- Edge cases first --------------------------------------------------
      const folderId = typeof input?.folderId === "string" ? input.folderId.trim() : "";
      const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
      if (folderId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listFiles requires a Drive folder id",
          userMessage: "Chưa khai báo thư mục Drive cho đơn vị này.",
          context: { tenant_id: tenantId || null },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId });
      const maxFiles = input?.maxFiles && input.maxFiles > 0 ? input.maxFiles : DEFAULT_MAX_FILES;
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      let malformed = 0;
      let pages = 0;

      do {
        let payload: unknown;
        try {
          const response = await drive.files.list({
            // Sub-folders are excluded: docs/05 section 3 keeps "Nghệ sĩ" and
            // "Ảnh hiển thị tiktok và shopee" out of the automated flow.
            q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
            fields: "nextPageToken, incompleteSearch, files(id, name, mimeType, size, modifiedTime)",
            pageSize: PAGE_SIZE,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: "name_natural",
          });
          payload = response.data;
        } catch (error) {
          // One code for every transport/permission failure; context says which
          // folder and which tenant so the log answers "why is the picker empty".
          throw AppError.from(error, "DRIVE_ERROR", {
            tenant_id: tenantId || null,
            folder_id: folderId,
            operation: "drive.files.list",
            page: pages,
          });
        }

        const parsedPage = DriveListResponseSchema.safeParse(payload);
        if (!parsedPage.success) {
          throw new AppError("DRIVE_ERROR", {
            message: "Drive files.list returned an unexpected payload shape",
            context: {
              tenant_id: tenantId || null,
              folder_id: folderId,
              issues: parsedPage.error.issues.map((issue) => issue.path.join(".")),
            },
          });
        }

        if (parsedPage.data.incompleteSearch === true) {
          log.warn("Drive reported an incomplete search — the listing may be partial", {
            folder_id: folderId,
          });
        }

        for (const entry of parsedPage.data.files ?? []) {
          const parsedFile = DriveFileSchema.safeParse(entry);
          if (!parsedFile.success) {
            malformed += 1;
            continue;
          }
          const file = parsedFile.data;
          files.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType ?? null,
            sizeBytes: toBytes(file.size),
            modifiedTime: file.modifiedTime ?? null,
          });
          if (files.length >= maxFiles) break;
        }

        pageToken = parsedPage.data.nextPageToken ?? undefined;
        pages += 1;
      } while (pageToken && files.length < maxFiles);

      if (malformed > 0) {
        log.warn("Drive returned entries without an id or a name", {
          folder_id: folderId,
          malformed_entries: malformed,
        });
      }
      log.info("Drive listing complete", { folder_id: folderId, files: files.length, pages });

      return files;
    },

    async download(input: DownloadDriveFileInput): Promise<DriveFileContent> {
      // --- Edge cases first --------------------------------------------------
      const fileId = typeof input?.fileId === "string" ? input.fileId.trim() : "";
      const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
      if (fileId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "download requires a Drive file id",
          userMessage: "Thiếu mã file trên Drive.",
          context: { tenant_id: tenantId || null },
        });
      }

      let payload: unknown;
      let headerMime: string | null = null;
      try {
        const response = await drive.files.get(
          { fileId, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        );
        payload = response.data;
        headerMime = readHeaderMime(response.headers);
      } catch (error) {
        const status = httpStatusOf(error);
        // 404 (deleted) and 403 (un-shared) are the same story for the operator:
        // this file is not reachable any more — that is not an outage.
        if (status === 404 || status === 403) {
          throw AppError.from(error, "MEDIA_NOT_FOUND", {
            tenant_id: tenantId || null,
            drive_file_id: fileId,
            operation: "drive.files.get",
            http_status: status,
          });
        }
        throw AppError.from(error, "DRIVE_ERROR", {
          tenant_id: tenantId || null,
          drive_file_id: fileId,
          operation: "drive.files.get",
          http_status: status ?? null,
        });
      }

      const bytes = toBinary(payload);
      if (!bytes) {
        throw new AppError("DRIVE_ERROR", {
          message: "Drive returned a body that is not binary content",
          userMessage: "Không tải được nội dung file từ Drive. Vui lòng thử lại.",
          context: {
            tenant_id: tenantId || null,
            drive_file_id: fileId,
            body_type: typeof payload,
          },
        });
      }

      const maxBytes =
        typeof input?.maxBytes === "number" && input.maxBytes > 0 ? input.maxBytes : null;
      if (maxBytes !== null && bytes.length > maxBytes) {
        throw new AppError("DRIVE_ERROR", {
          message: "Drive file is larger than the caller's byte budget",
          userMessage: "File trên Drive quá lớn để phục vụ trực tiếp.",
          context: {
            tenant_id: tenantId || null,
            drive_file_id: fileId,
            size_bytes: bytes.length,
            max_bytes: maxBytes,
            reason: "CONTENT_TOO_LARGE",
          },
        });
      }

      deps.logger.child({ tenant_id: tenantId }).debug("Drive file downloaded", {
        drive_file_id: fileId,
        bytes: bytes.length,
        mime_type: headerMime,
      });

      return { fileId, bytes, mimeType: headerMime, sizeBytes: bytes.length };
    },
  };
}

/** googleapis hands back ArrayBuffer/Buffer depending on the transport. */
function toBinary(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

function readHeaderMime(headers: unknown): string | null {
  if (!headers || typeof headers !== "object") return null;
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("content-type")
      : (headers as Record<string, unknown>)["content-type"];
  if (typeof raw !== "string") return null;
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length > 0 ? mime : null;
}

/** Status of a googleapis error, whichever shape this version throws. */
function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.code, candidate.response?.status]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function toBytes(size: string | null | undefined): number | null {
  if (typeof size !== "string" || size.trim().length === 0) return null;
  const value = Number.parseInt(size, 10);
  return Number.isFinite(value) ? value : null;
}
