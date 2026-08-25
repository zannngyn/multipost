import type { CatalogFieldMap, StockPolicy } from "@/core/domain/catalog-field-map";
import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import type { MediaProfile } from "@/core/domain/media-profile";
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
  /**
   * The mapping this tenant DECLARED, or null when it never declared one and is
   * therefore running on the MYSP preset.
   *
   * The distinction is the point: null means "chưa khai — an toàn để điền theo
   * gợi ý", a value means "người ta đã chỉnh tay — đừng ghi đè". A map that was
   * declared and happens to equal the preset is NOT null, which is why this is
   * read from the stored blob and never inferred by comparing with the preset.
   */
  readonly fieldMap: CatalogFieldMap | null;
  /** Same contract: null = chưa khai (chạy `numeric`), not "khai là numeric". */
  readonly stockPolicy: StockPolicy | null;
  /**
   * Same contract again, for onboarding phase 2: null = chưa khai (chạy
   * `code-color-seq`), NOT "đã khai là code-color-seq".
   *
   * It is read from the stored blob and never inferred by comparing with
   * DEFAULT_MEDIA_PROFILE, for the same reason as `fieldMap`: a tenant who
   * deliberately picked the default would otherwise be shown as "chưa khai" and
   * invited to re-pick from the suggestion — a silent overwrite of their choice.
   */
  readonly mediaProfile: MediaProfile | null;
  /**
   * Where the product TEXT is read from (onboarding phase 3). Same contract as
   * the two above: null = chưa khai, tức đang đọc bảng tính Google — NOT "đã
   * khai là google_sheet".
   *
   * The screen needs the whole value, not just the kind: `fileName` and
   * `uploadedAt` are what answer "đang đọc file nào, tải lên lúc nào", which is
   * the first question when an operator edits their local copy and the numbers
   * do not move.
   */
  readonly textSource: CatalogTextConfig | null;
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
    // `?? null`, never a default object: the repo omits these keys when the
    // tenant never declared them, and that absence is information the wizard
    // needs (see CatalogSourceView).
    fieldMap: source.fieldMap ?? null,
    stockPolicy: source.stockPolicy ?? null,
    mediaProfile: source.mediaProfile ?? null,
    textSource: source.textSource ?? null,
    // The ids come from a hand-edited JSONB blob: encode them so a stray
    // character cannot break out of the path segment it belongs to.
    driveFolderUrl: `${DRIVE_FOLDER_URL}${encodeURIComponent(source.driveFolderId)}`,
    spreadsheetUrl: `${SPREADSHEET_URL}${encodeURIComponent(source.spreadsheetId)}`,
  };
}
