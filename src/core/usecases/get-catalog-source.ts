import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E2 — "nguồn dữ liệu" panel: which Drive folder and which Sheet tab this
 * tenant syncs from, plus links an operator can open. READ ONLY.
 *
 * Null means "chưa cấu hình" and covers three cases on purpose — no integration
 * row, a row missing keys, a disabled row — because all three leave the
 * operator with the same next action: go and configure the source. The repo
 * logs which one it was; the screen does not need to distinguish them.
 */

const DRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/";
const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/";

export interface GetCatalogSourceInput {
  readonly tenantId: TenantId;
}

export interface CatalogSourceView {
  readonly driveFolderId: string;
  readonly spreadsheetId: string;
  readonly sheetName: string;
  readonly driveFolderUrl: string;
  readonly spreadsheetUrl: string;
}

export interface GetCatalogSourceDeps {
  catalogConfig: CatalogConfigRepo;
  logger: Logger;
}

export function makeGetCatalogSource(deps: GetCatalogSourceDeps) {
  return async function getCatalogSource(
    input: GetCatalogSourceInput,
  ): Promise<CatalogSourceView | null> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "getCatalogSource requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const source = await deps.catalogConfig.findCatalogSource(tenantId);
    if (!source) {
      deps.logger.debug("Catalog source panel: tenant has no usable google integration", {
        tenant_id: tenantId,
      });
      return null;
    }

    return toCatalogSourceView(source);
  };
}

export type GetCatalogSource = ReturnType<typeof makeGetCatalogSource>;

/**
 * One shape for the panel, whether it was just read or just saved — so the UI
 * can swap the response of a PUT straight into the state a GET produced.
 */
export function toCatalogSourceView(source: CatalogSourceConfig): CatalogSourceView {
  return {
    driveFolderId: source.driveFolderId,
    spreadsheetId: source.spreadsheetId,
    sheetName: source.sheetName,
    // The ids come from a hand-edited JSONB blob: encode them so a stray
    // character cannot break out of the path segment it belongs to.
    driveFolderUrl: `${DRIVE_FOLDER_URL}${encodeURIComponent(source.driveFolderId)}`,
    spreadsheetUrl: `${SPREADSHEET_URL}${encodeURIComponent(source.spreadsheetId)}`,
  };
}
