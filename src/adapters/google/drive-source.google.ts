import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { DriveFile, DriveSource, ListDriveFilesInput } from "@/core/ports/drive-source";
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
  };
}

function toBytes(size: string | null | undefined): number | null {
  if (typeof size !== "string" || size.trim().length === 0) return null;
  const value = Number.parseInt(size, 10);
  return Number.isFinite(value) ? value : null;
}
