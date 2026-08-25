import { suggestFieldMap, type FieldMapSuggestion } from "@/core/domain/catalog-field-map";
import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type {
  CatalogFileRef,
  CatalogReadNotice,
  CatalogTextSource,
} from "@/core/ports/catalog-text-source";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import { toCatalogSourceView, type CatalogSourceView } from "./get-catalog-source";
import { MAX_CATALOG_TEXT_BYTES } from "./read-catalog-text";
import { resolveActorUserId } from "./resolve-actor";

/**
 * Onboarding phase 3 — the tenant hands us their product table as a CSV.
 *
 * ORDER IS THE POINT, and it is the opposite of the obvious one:
 *   1. READ the bytes first, through the same adapter every later sync will
 *      use. A file that cannot be read never reaches the disk, so a tenant can
 *      never end up configured to read something unreadable. This is also what
 *      turns "sai định dạng" into an error while the operator is still looking
 *      at the screen, instead of at 6am tomorrow in a background sync.
 *   2. STORE the bytes.
 *   3. POINT the config at them.
 *   4. Only THEN delete the file this one replaces. A crash between 3 and 4
 *      leaves a few unused KB; the other order can leave a tenant whose config
 *      points at bytes that are gone (PM decision, 24/08/2026: no sweep job —
 *      harmless rubbish beats deleting a file that is in use).
 *
 * It writes NO products: uploading a table is not syncing it. The catalog still
 * describes the previous source until someone runs a sync — same contract as
 * `updateCatalogSource`, and the UI says so.
 */

export interface UploadCatalogFileInput {
  readonly tenantId: TenantId;
  /** Name as the operator uploaded it — shown on the sync screen afterwards. */
  readonly fileName: string;
  /** Declared MIME type; null when the browser did not say. Only a hint. */
  readonly contentType?: string | null;
  readonly bytes: Uint8Array;
  /**
   * Field separator the operator picked, when they overrode the detection.
   * Absent = detect on every read and report what was detected.
   */
  readonly delimiter?: string | null;
  readonly actorEmail?: string | null;
  readonly actorUserId?: string | null;
}

/** What the operator is shown right after the upload, before mapping columns. */
export interface CatalogFilePreview {
  readonly columns: readonly string[];
  /** Data rows, header excluded. */
  readonly rowCount: number;
  /** Separator actually used, e.g. ";" — plus whether it was inferred. */
  readonly delimiter: string | null;
  readonly delimiterDetected: boolean;
  readonly encoding: string | null;
  /** Every deviation the reader saw: ragged rows, blank rows dropped, `sep=`. */
  readonly notices: readonly CatalogReadNotice[];
  /** First rows as read, so the operator can check the columns line up. */
  readonly sampleRows: readonly Readonly<Record<string, string>>[];
  /**
   * Proposed column mapping for THIS file, so the wizard can pre-fill step 2.
   * A suggestion only — nothing is stored until the operator confirms it.
   */
  readonly fieldMapSuggestion: FieldMapSuggestion;
}

export interface UploadCatalogFileResult {
  /** The tenant's source AFTER the save — same shape a GET returns. */
  readonly source: CatalogSourceView;
  readonly preview: CatalogFilePreview;
  /** The file this upload replaced, if any, and whether its bytes are gone. */
  readonly replaced: { readonly storageKey: string; readonly deleted: boolean } | null;
}

/** Rows echoed back for the preview table. */
const MAX_SAMPLE_ROWS = 5;

export interface UploadCatalogFileDeps {
  /** The reader for uploaded files — the SAME one a later sync uses. */
  catalogSource: CatalogTextSource;
  catalogFiles: CatalogFileStore;
  catalogConfig: CatalogConfigRepo;
  clock: Clock;
  logger: Logger;
  /** Optional: without it the audit row carries the e-mail but no actor id. */
  users?: UserRepo;
}

export function makeUploadCatalogFile(deps: UploadCatalogFileDeps) {
  return async function uploadCatalogFile(
    input: UploadCatalogFileInput,
  ): Promise<UploadCatalogFileResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "uploadCatalogFile requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const log = deps.logger.child({ tenant_id: tenantId });

    const fileName = typeof input?.fileName === "string" ? input.fileName.trim() : "";
    if (fileName.length === 0 || fileName.length > 255) {
      throw new AppError("INVALID_INPUT", {
        message: "uploadCatalogFile requires a file name of 1..255 characters",
        userMessage: "Thiếu tên file, hoặc tên file quá dài.",
        context: { tenant_id: tenantId, field: "fileName", reason: "CATALOG_FILE_NAME_INVALID" },
      });
    }

    const bytes = input?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "uploadCatalogFile requires a non-empty file",
        userMessage: "File tải lên rỗng — hãy xuất lại file rồi thử lại.",
        context: { tenant_id: tenantId, field: "bytes", reason: "CATALOG_FILE_EMPTY" },
      });
    }
    if (bytes.length > MAX_CATALOG_TEXT_BYTES) {
      throw new AppError("INVALID_INPUT", {
        message: "uploadCatalogFile received a file over the byte cap",
        userMessage: `File nặng hơn mức cho phép (${Math.round(MAX_CATALOG_TEXT_BYTES / (1024 * 1024))} MB) — xoá bớt cột/dòng không cần rồi xuất lại.`,
        context: {
          tenant_id: tenantId,
          field: "bytes",
          reason: "CATALOG_FILE_TOO_LARGE",
          size_bytes: bytes.length,
          max_bytes: MAX_CATALOG_TEXT_BYTES,
        },
      });
    }

    const ref: CatalogFileRef = {
      kind: "file",
      fileName,
      contentType: typeof input?.contentType === "string" ? input.contentType : null,
      bytes,
      ...(typeof input?.delimiter === "string" && input.delimiter.length > 0
        ? { delimiter: input.delimiter }
        : {}),
    };

    if (!deps.catalogSource.canRead(ref)) {
      // Defensive: the wired reader is the CSV one, which claims every file.
      throw new AppError("INVALID_INPUT", {
        message: "The wired catalog source cannot read an uploaded file",
        userMessage: "Hệ thống chưa đọc được loại file này — hãy tải lên file .csv.",
        context: { tenant_id: tenantId, reason: "TEXT_SOURCE_NOT_SUPPORTED", file_name: fileName },
      });
    }

    // --- 1. Read BEFORE storing: an unreadable file never becomes config ----
    // The adapter raises coded refusals (Excel workbook, wrong encoding, no
    // rows) with a Vietnamese message that names the fix. They travel up
    // unchanged: the operator is looking at the screen right now.
    const read = await deps.catalogSource.readCatalog({ tenantId, ref });

    if (read.snapshot.columns.length === 0) {
      log.warn("Catalog file upload refused: no readable header row", {
        error_code: "INVALID_INPUT",
        reason: "CATALOG_FILE_NO_COLUMNS",
        file_name: fileName,
      });
      throw new AppError("INVALID_INPUT", {
        message: "Uploaded catalog file has no readable header row",
        userMessage:
          "Dòng đầu tiên của file không có tên cột nào đọc được. Hệ thống đọc cột theo TÊN, nên dòng đầu phải là tiêu đề (ví dụ: Mã sản phẩm, Tên sản phẩm, Tồn).",
        context: { tenant_id: tenantId, reason: "CATALOG_FILE_NO_COLUMNS", file_name: fileName },
      });
    }

    if (read.snapshot.rows.length === 0) {
      log.warn("Catalog file upload refused: header only, no product rows", {
        error_code: "INVALID_INPUT",
        reason: "CATALOG_FILE_NO_PRODUCT_ROWS",
        file_name: fileName,
      });
      throw new AppError("INVALID_INPUT", {
        message: "Uploaded catalog file has a header but no data rows",
        userMessage:
          "File chỉ có dòng tiêu đề, không có dòng sản phẩm nào — kiểm tra lại file rồi tải lên lại.",
        context: {
          tenant_id: tenantId,
          reason: "CATALOG_FILE_NO_PRODUCT_ROWS",
          file_name: fileName,
        },
      });
    }

    // --- 2. Store the exact bytes that were just read successfully ---------
    const stored = await deps.catalogFiles.put({ tenantId, fileName, bytes });

    // --- 3. Point the config at them ---------------------------------------
    const textSource: CatalogTextConfig = {
      kind: "file",
      storageKey: stored.storageKey,
      fileName,
      contentType: ref.contentType,
      sizeBytes: stored.sizeBytes,
      uploadedAt: deps.clock.now().toISOString(),
      ...(ref.delimiter ? { delimiter: ref.delimiter } : {}),
    };

    const actorEmail =
      typeof input?.actorEmail === "string" ? input.actorEmail.trim().toLowerCase() || null : null;
    const actorUserId = await resolveActorUserId(
      { users: deps.users },
      tenantId,
      { actorUserId: input?.actorUserId ?? null, actorEmail },
      log,
    );

    // ONLY the key this upload owns. The Drive folder, the tab and the column
    // mapping are left out entirely, so the repo keeps whatever the row holds
    // under its lock: reading them here and sending them back would revert an
    // edit another operator made in between (F3, the lost update).
    let previous: Awaited<ReturnType<CatalogConfigRepo["saveCatalogSource"]>>["previous"];
    try {
      ({ previous } = await deps.catalogConfig.saveCatalogSource({
        tenantId,
        source: { textSource },
        actorUserId,
        actorEmail,
      }));
    } catch (error) {
      // The bytes are on disk but no config points at them. Say so with the key
      // in the log: it is the only way to find that orphan later.
      const appError = AppError.from(error, "DB_ERROR", {
        tenant_id: tenantId,
        reason: "CATALOG_FILE_CONFIG_SAVE_FAILED",
        storage_key: stored.storageKey,
      });
      log.error("Catalog file stored but the config could not be updated", {
        ...appError.toLogObject(),
        reason: "CATALOG_FILE_CONFIG_SAVE_FAILED",
        storage_key: stored.storageKey,
      });
      throw appError;
    }

    // --- 4. Delete the file this one replaced, never before the save -------
    const replacedKey =
      previous?.textSource?.kind === "file" && previous.textSource.storageKey !== stored.storageKey
        ? previous.textSource.storageKey
        : null;
    const replaced = replacedKey
      ? { storageKey: replacedKey, deleted: await deleteReplaced(deps, tenantId, replacedKey, log) }
      : null;

    log.info("Catalog file uploaded", {
      file_name: fileName,
      storage_key: stored.storageKey,
      size_bytes: stored.sizeBytes,
      delimiter: read.format.delimiter,
      delimiter_detected: read.format.detected,
      encoding: read.format.encoding,
      columns: read.snapshot.columns.length,
      rows: read.snapshot.rows.length,
      notice_codes: read.notices.map((notice) => notice.code),
      actor_email: actorEmail,
      actor_user_id: actorUserId,
      replaced_storage_key: replaced?.storageKey ?? null,
      replaced_deleted: replaced?.deleted ?? null,
      previous_text_source: previous?.textSource?.kind ?? null,
      note: "catalog is stale until the next sync",
    });

    return {
      // Built from `previous` — the state the repo read UNDER THE LOCK — plus
      // the one key this call changed. That is the row as it stands now.
      source: toCatalogSourceView({
        driveFolderId: previous?.driveFolderId ?? "",
        spreadsheetId: previous?.spreadsheetId ?? "",
        sheetName: previous?.sheetName ?? "",
        ...(previous?.fieldMap ? { fieldMap: previous.fieldMap } : {}),
        ...(previous?.stockPolicy ? { stockPolicy: previous.stockPolicy } : {}),
        ...(previous?.mediaProfile ? { mediaProfile: previous.mediaProfile } : {}),
        textSource,
      }),
      preview: {
        columns: read.snapshot.columns,
        rowCount: read.snapshot.rows.length,
        delimiter: read.format.delimiter,
        delimiterDetected: read.format.detected,
        encoding: read.format.encoding,
        notices: read.notices,
        sampleRows: read.snapshot.rows.slice(0, MAX_SAMPLE_ROWS).map((row) => row.values),
        fieldMapSuggestion: suggestFieldMap(read.snapshot.columns),
      },
      replaced,
    };
  };
}

export type UploadCatalogFile = ReturnType<typeof makeUploadCatalogFile>;

/**
 * Removes the replaced file. A failure here is logged and swallowed ON PURPOSE
 * — and this is the only place in this usecase where that is right: the new
 * file is stored and the config already points at it, so the upload SUCCEEDED.
 * Failing it now would tell the operator to upload again over a config that is
 * already correct. What is left behind is a few unused KB, named in the log.
 */
async function deleteReplaced(
  deps: UploadCatalogFileDeps,
  tenantId: TenantId,
  storageKey: string,
  log: Logger,
): Promise<boolean> {
  try {
    return await deps.catalogFiles.delete({ tenantId, storageKey });
  } catch (error) {
    const appError = AppError.from(error, "INTERNAL", {
      tenant_id: tenantId,
      reason: "CATALOG_FILE_REPLACE_DELETE_FAILED",
      storage_key: storageKey,
    });
    log.warn("Could not delete the replaced catalog file — leaving it on disk", {
      ...appError.toLogObject(),
      reason: "CATALOG_FILE_REPLACE_DELETE_FAILED",
      storage_key: storageKey,
    });
    return false;
  }
}
