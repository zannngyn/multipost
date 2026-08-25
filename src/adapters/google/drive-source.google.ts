import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type {
  DownloadDriveFileInput,
  DriveFile,
  DriveFileContent,
  DriveListing,
  DriveListingLimit,
  DriveSource,
  ListDriveFilesDeepInput,
  ListDriveFilesInput,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import { escapeQueryValue } from "./drive-query";
import type { TenantGoogleAuth } from "./tenant-google-auth";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * Drive implementation of DriveSource (E2).
 * Everything Google returns is parsed through a schema before it becomes a
 * domain value: an entry without an id or a name is dropped here with a log
 * line, never handed upward as a half-built asset (technical rule 2).
 *
 * WHICH identity reads the folder is decided PER TENANT (see
 * tenant-google-auth): the tenant's own OAuth connection when there is one, the
 * Service Account otherwise. A dead connection surfaces as GOOGLE_AUTH_EXPIRED
 * and stops the sync — it must never look like an empty folder, because the
 * sync deletes what a listing no longer contains.
 */

const FOLDER_MIME = "application/vnd.google-apps.folder";
const PAGE_SIZE = 1000;
/** Guard against an accidental full-Drive crawl: the real folder holds ~5,500. */
const DEFAULT_MAX_FILES = 20000;

/**
 * Caps of the RECURSIVE listing. They exist for one reason: Drive quota. A walk
 * that asks per folder turns a 300-product catalog into 300+ queries per sync,
 * and a folder tree nobody checked (someone shares "My Drive") into thousands.
 * Every cap that bites is reported in `DriveListing.limitsHit`, never silent.
 */
export const DEFAULT_MAX_DEPTH = 2;
/** Hard ceiling, whatever the caller asks for. */
export const MAX_ALLOWED_DEPTH = 5;
/** 1,000 folders = ~40 batched queries; a real catalog holds ~300 products. */
export const DEFAULT_MAX_FOLDERS = 1000;
/**
 * Parents grouped into ONE `q`. Drive has no documented limit on the number of
 * `in parents` clauses, but the query string does have one, and ids are ~33
 * characters: 25 keeps it around 1 KB.
 */
export const PARENTS_PER_QUERY = 25;

const DriveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1).nullish(),
  /** Drive returns size as a decimal string, and omits it for some types. */
  size: z.string().nullish(),
  modifiedTime: z.string().nullish(),
});

/** Same entry plus the parent ids — only the recursive listing asks for them. */
const DriveDeepFileSchema = DriveFileSchema.extend({
  parents: z.array(z.string().min(1)).nullish(),
});

const DriveListResponseSchema = z.object({
  files: z.array(z.unknown()).nullish(),
  nextPageToken: z.string().nullish(),
  incompleteSearch: z.boolean().nullish(),
});

export interface GoogleDriveSourceDeps {
  auth: TenantGoogleAuth;
  logger: Logger;
}

export function makeGoogleDriveSource(deps: GoogleDriveSourceDeps): DriveSource {
  /** Per tenant, because the identity is per tenant. The client itself is cheap. */
  const driveFor = async (tenantId: TenantId) =>
    google.drive({ version: "v3", auth: await deps.auth.forTenant(tenantId) });

  return {
    async listFiles(input: ListDriveFilesInput): Promise<readonly DriveFile[]> {
      // --- Edge cases first --------------------------------------------------
      const folderId = typeof input?.folderId === "string" ? input.folderId.trim() : "";
      const tenantId = normalizeTenantId(input.tenantId);
      if (folderId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listFiles requires a Drive folder id",
          userMessage: "Chưa khai báo thư mục Drive cho đơn vị này.",
          context: { tenant_id: tenantId || null },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId });
      // Resolved BEFORE the loop: a revoked connection must stop the sync here,
      // not hand back an empty list that reads as "the folder was emptied".
      const drive = await driveFor(tenantId);
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
            q: `'${escapeQueryValue(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
            fields: "nextPageToken, incompleteSearch, files(id, name, mimeType, size, modifiedTime)",
            pageSize: PAGE_SIZE,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: "name_natural",
          });
          payload = response.data;
        } catch (error) {
          // An auth rejection of a CONNECTED tenant is its own story: the token
          // died mid-listing, and "kết nối lại" is the only fix.
          const authError = await deps.auth.reportAuthFailure(tenantId, error);
          if (authError) throw authError;
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

    /**
     * Recursive listing for the `folder-per-code` / `sheet-column` profiles.
     *
     * Breadth-first, one query per BATCH of parents (not per folder), files and
     * sub-folders discovered in the same pass. Stops at the first cap it hits
     * and reports which one: the caller must be able to tell "the folder holds
     * 40 files" from "I gave up after 20,000".
     */
    async listFilesDeep(input: ListDriveFilesDeepInput): Promise<DriveListing> {
      // --- Edge cases first --------------------------------------------------
      const folderId = typeof input?.folderId === "string" ? input.folderId.trim() : "";
      const tenantId = normalizeTenantId(input.tenantId);
      if (folderId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listFilesDeep requires a Drive folder id",
          userMessage: "Chưa khai báo thư mục Drive cho đơn vị này.",
          context: { tenant_id: tenantId || null },
        });
      }

      const log = deps.logger.child({ tenant_id: tenantId });
      const drive = await driveFor(tenantId);
      const maxFiles = positive(input?.maxFiles) ?? DEFAULT_MAX_FILES;
      const maxFolders = positive(input?.maxFolders) ?? DEFAULT_MAX_FOLDERS;
      const maxDepth = Math.min(
        typeof input?.maxDepth === "number" && input.maxDepth >= 0
          ? Math.floor(input.maxDepth)
          : DEFAULT_MAX_DEPTH,
        MAX_ALLOWED_DEPTH,
      );

      const files: DriveFile[] = [];
      const seenFileIds = new Set<string>();
      const seenFolderIds = new Set<string>([folderId]);
      const limitsHit = new Set<DriveListingLimit>();
      let foldersVisited = 0;
      let depthReached = 0;
      let malformed = 0;
      let queries = 0;

      let level: Array<{ id: string; path: readonly string[] }> = [{ id: folderId, path: [] }];

      // Labelled so every cap can leave the whole walk at once — a `break`
      // inside the page loop would only end the current batch.
      walk: for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
        depthReached = depth;
        const next: Array<{ id: string; path: readonly string[] }> = [];

        for (let start = 0; start < level.length; start += PARENTS_PER_QUERY) {
          const batch = level.slice(start, start + PARENTS_PER_QUERY);
          const byId = new Map(batch.map((folder) => [folder.id, folder]));
          const parentsClause = batch
            .map((folder) => `'${escapeQueryValue(folder.id)}' in parents`)
            .join(" or ");
          let pageToken: string | undefined;

          do {
            let payload: unknown;
            try {
              const response = await drive.files.list({
                // Folders are NOT excluded here: they are how the next level is
                // discovered, and one query answering both halves is the whole
                // point of the batching.
                q: `(${parentsClause}) and trashed = false`,
                fields:
                  "nextPageToken, incompleteSearch, files(id, name, mimeType, size, modifiedTime, parents)",
                pageSize: PAGE_SIZE,
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                orderBy: "name_natural",
              });
              payload = response.data;
              queries += 1;
            } catch (error) {
              const authError = await deps.auth.reportAuthFailure(tenantId, error);
              if (authError) throw authError;
              throw AppError.from(error, "DRIVE_ERROR", {
                tenant_id: tenantId || null,
                folder_id: folderId,
                operation: "drive.files.list",
                depth,
                parents: batch.length,
                queries,
              });
            }

            const parsedPage = DriveListResponseSchema.safeParse(payload);
            if (!parsedPage.success) {
              throw new AppError("DRIVE_ERROR", {
                message: "Drive files.list returned an unexpected payload shape",
                context: {
                  tenant_id: tenantId || null,
                  folder_id: folderId,
                  depth,
                  issues: parsedPage.error.issues.map((issue) => issue.path.join(".")),
                },
              });
            }

            if (parsedPage.data.incompleteSearch === true) {
              log.warn("Drive reported an incomplete search — the listing may be partial", {
                folder_id: folderId,
                depth,
              });
            }

            for (const entry of parsedPage.data.files ?? []) {
              const parsedFile = DriveDeepFileSchema.safeParse(entry);
              if (!parsedFile.success) {
                malformed += 1;
                continue;
              }
              const file = parsedFile.data;
              // Which of the batched parents this entry came from. A file can
              // have several; only the one we asked for is meaningful here.
              const parent = (file.parents ?? []).find((id) => byId.has(id)) ?? null;
              const owner = parent ? byId.get(parent) : undefined;
              const path = owner?.path ?? [];

              if (file.mimeType === FOLDER_MIME) {
                if (depth >= maxDepth) {
                  limitsHit.add("MAX_DEPTH");
                  continue;
                }
                if (foldersVisited >= maxFolders) {
                  limitsHit.add("MAX_FOLDERS");
                  continue;
                }
                if (seenFolderIds.has(file.id)) continue;
                seenFolderIds.add(file.id);
                foldersVisited += 1;
                next.push({ id: file.id, path: [...path, file.name] });
                continue;
              }

              if (files.length >= maxFiles) {
                limitsHit.add("MAX_FILES");
                break walk;
              }
              // A file with two parents is returned once per parent.
              if (seenFileIds.has(file.id)) continue;
              seenFileIds.add(file.id);
              files.push({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType ?? null,
                sizeBytes: toBytes(file.size),
                modifiedTime: file.modifiedTime ?? null,
                parentFolderId: parent ?? (batch.length === 1 ? batch[0].id : null),
                folderPath: path,
              });
            }

            pageToken = parsedPage.data.nextPageToken ?? undefined;
          } while (pageToken);
        }

        level = next;
      }

      if (malformed > 0) {
        log.warn("Drive returned entries without an id or a name", {
          folder_id: folderId,
          malformed_entries: malformed,
        });
      }

      const listing: DriveListing = {
        files,
        foldersVisited,
        depthReached,
        limitsHit: [...limitsHit],
      };

      if (listing.limitsHit.length > 0) {
        // Loud: a truncated listing must never be mistaken for a complete one,
        // because the sync deletes what a listing no longer contains.
        log.warn("Recursive Drive listing stopped at a cap — the result is PARTIAL", {
          error_code: "DRIVE_LISTING_TRUNCATED",
          folder_id: folderId,
          limits_hit: listing.limitsHit,
          files: files.length,
          folders_visited: foldersVisited,
          depth_reached: depthReached,
          max_files: maxFiles,
          max_folders: maxFolders,
          max_depth: maxDepth,
          queries,
        });
      } else {
        log.info("Recursive Drive listing complete", {
          folder_id: folderId,
          files: files.length,
          folders_visited: foldersVisited,
          depth_reached: depthReached,
          queries,
        });
      }

      return listing;
    },

    async download(input: DownloadDriveFileInput): Promise<DriveFileContent> {
      // --- Edge cases first --------------------------------------------------
      const fileId = typeof input?.fileId === "string" ? input.fileId.trim() : "";
      const tenantId = normalizeTenantId(input.tenantId);
      if (fileId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "download requires a Drive file id",
          userMessage: "Thiếu mã file trên Drive.",
          context: { tenant_id: tenantId || null },
        });
      }

      const drive = await driveFor(tenantId);
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
        const authError = await deps.auth.reportAuthFailure(tenantId, error);
        if (authError) throw authError;
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

/** Null for anything that is not a usable positive cap. */
function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function toBytes(size: string | null | undefined): number | null {
  if (typeof size !== "string" || size.trim().length === 0) return null;
  const value = Number.parseInt(size, 10);
  return Number.isFinite(value) ? value : null;
}
