import {
  DEFAULT_CATALOG_TEXT_CONFIG,
  type CatalogTextConfig,
} from "@/core/domain/catalog-text-config";
import { AppError } from "@/core/domain/errors";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type {
  CatalogFileRef,
  CatalogSourceRef,
  CatalogTextResult,
  CatalogTextSource,
} from "@/core/ports/catalog-text-source";
import type { Logger } from "@/core/ports/infra";
import type { SheetSource } from "@/core/ports/sheet-source";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * ONE way to turn "this tenant's configured source" into a snapshot
 * (onboarding phase 3), shared by `sync-catalog` and `profile-catalog-source`.
 *
 * It lives in `usecases` rather than in an adapter because the decisions are
 * business ones: which implementation may read this ref, and what it MEANS when
 * none can. Both callers must answer those the same way — a compatibility
 * report that silently read a different source than the sync does would be
 * worse than no report at all.
 */

/** Hard cap on a stored catalog file, mirroring the upload adapter's own. */
export const MAX_CATALOG_TEXT_BYTES = 5 * 1024 * 1024;

export interface CatalogTextReaderDeps {
  /**
   * Every product-text source this process can read from. The reader picks by
   * ref; optional so a container wired before phase 3 keeps working.
   */
  catalogSources?: readonly CatalogTextSource[];
  /** Where an uploaded catalog file's bytes live. Required for a file source. */
  catalogFiles?: CatalogFileStore;
  /**
   * Legacy single-source wiring: used only when nothing in `catalogSources` can
   * read a GOOGLE SHEET ref, so a tenant on a tab never depends on new wiring.
   */
  sheet?: SheetSource;
}

export interface ReadCatalogTextArgs {
  readonly tenantId: TenantId;
  readonly ref: CatalogSourceRef;
  readonly log: Logger;
}

/**
 * Reads the table behind a ref.
 *
 * Failure policy — neither of these may ever look like "an empty catalog":
 *   - no implementation can read a FILE ref -> TEXT_SOURCE_NOT_SUPPORTED (this
 *     process was not wired for it);
 *   - a sheet ref with no reader at all -> the legacy `sheet` port, or the same
 *     coded refusal when that is missing too.
 */
export async function readCatalogText(
  deps: CatalogTextReaderDeps,
  args: ReadCatalogTextArgs,
): Promise<CatalogTextResult> {
  const { tenantId, ref, log } = args;

  const source = deps.catalogSources?.find((candidate) => candidate.canRead(ref));
  if (source) {
    const result = await source.readCatalog({ tenantId, ref });
    log.info("Catalog text read", {
      ref_kind: ref.kind,
      source_id: result.format.source,
      delimiter: result.format.delimiter,
      encoding: result.format.encoding,
      detected: result.format.detected,
      columns: result.snapshot.columns.length,
      rows: result.snapshot.rows.length,
      notice_codes: result.notices.map((notice) => notice.code),
    });
    return result;
  }

  if (ref.kind === "google_sheet" && deps.sheet) {
    const snapshot = await deps.sheet.readRows({
      tenantId,
      spreadsheetId: ref.spreadsheetId,
      sheetName: ref.sheetName,
    });
    return {
      snapshot,
      format: { source: "google-sheet", delimiter: null, encoding: null, detected: false },
      notices: [],
    };
  }

  // Nothing can read this ref: the process was not wired for it. Loud, with a
  // named reason — a tenant whose catalog lives in an uploaded file must never
  // be told "bảng dữ liệu trống".
  log.error("No catalog source in this process can read the tenant's source", {
    error_code: "SYNC_FAILED",
    reason: "TEXT_SOURCE_NOT_SUPPORTED",
    ref_kind: ref.kind,
  });
  throw new AppError("SYNC_FAILED", {
    message: `No CatalogTextSource in this process can read a '${ref.kind}' ref`,
    userMessage:
      "Hệ thống chưa bật chế độ đọc nguồn dữ liệu này ở tiến trình này — báo quản trị viên.",
    context: { tenant_id: tenantId, reason: "TEXT_SOURCE_NOT_SUPPORTED", ref_kind: ref.kind },
  });
}

/**
 * Stored file config -> a ref carrying the bytes that are on disk.
 *
 * The two failures are different on purpose: no store WIRED is a deployment
 * problem, a stored file that is GONE is something the operator fixes by
 * uploading again — and neither is an empty catalog.
 */
export async function loadCatalogFileRef(
  deps: CatalogTextReaderDeps,
  args: { tenantId: TenantId; textConfig: CatalogTextConfig; log: Logger },
): Promise<CatalogFileRef> {
  const { tenantId, textConfig, log } = args;
  if (textConfig.kind !== "file") {
    throw new AppError("INTERNAL", {
      message: "loadCatalogFileRef called for a non-file text source",
      context: { tenant_id: tenantId, reason: "TEXT_SOURCE_KIND_MISMATCH" },
    });
  }

  if (!deps.catalogFiles) {
    log.error("No catalog file store wired in this process", {
      error_code: "SYNC_FAILED",
      reason: "CATALOG_FILE_STORE_MISSING",
    });
    throw new AppError("SYNC_FAILED", {
      message: "Tenant reads from an uploaded file but no CatalogFileStore is wired",
      userMessage:
        "Hệ thống chưa bật chế độ đọc file bảng dữ liệu ở tiến trình này — báo quản trị viên.",
      context: { tenant_id: tenantId, reason: "CATALOG_FILE_STORE_MISSING" },
    });
  }

  const stored = await deps.catalogFiles.get({
    tenantId,
    storageKey: textConfig.storageKey,
    maxBytes: MAX_CATALOG_TEXT_BYTES,
  });

  // The config points at bytes that are not there any more. Reporting this as
  // an empty table would put `deleteStale` in play and tell the operator their
  // products vanished.
  if (!stored) {
    log.error("The uploaded catalog file is gone", {
      error_code: "SYNC_FAILED",
      reason: "CATALOG_FILE_MISSING",
      file_name: textConfig.fileName,
    });
    throw new AppError("SYNC_FAILED", {
      message: "The stored catalog file could not be found",
      userMessage: `Không tìm thấy file bảng dữ liệu "${textConfig.fileName}" đã tải lên trước đây — hãy tải lên lại file .csv rồi đồng bộ lại.`,
      context: {
        tenant_id: tenantId,
        reason: "CATALOG_FILE_MISSING",
        file_name: textConfig.fileName,
      },
    });
  }

  return {
    kind: "file",
    fileName: textConfig.fileName,
    contentType: textConfig.contentType ?? null,
    bytes: stored.bytes,
    ...(typeof textConfig.delimiter === "string" && textConfig.delimiter.length > 0
      ? { delimiter: textConfig.delimiter }
      : {}),
  };
}

/**
 * Config -> ref, loading bytes when the tenant reads a file. Absent config is
 * the Google tab, exactly as before phase 3.
 */
export async function resolveCatalogSourceRef(
  deps: CatalogTextReaderDeps,
  args: {
    tenantId: TenantId;
    textConfig?: CatalogTextConfig | null;
    spreadsheetId: string;
    sheetName: string;
    log: Logger;
  },
): Promise<CatalogSourceRef> {
  const textConfig = args.textConfig ?? DEFAULT_CATALOG_TEXT_CONFIG;
  if (textConfig.kind === "file") {
    return await loadCatalogFileRef(deps, {
      tenantId: args.tenantId,
      textConfig,
      log: args.log,
    });
  }
  return { kind: "google_sheet", spreadsheetId: args.spreadsheetId, sheetName: args.sheetName };
}
