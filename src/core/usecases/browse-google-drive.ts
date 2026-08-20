import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type {
  GoogleDriveBrowser,
  GoogleOAuthRepo,
  ListGoogleFoldersResult,
  ListGoogleSpreadsheetsResult,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E2 — the in-app Drive picker behind "Kết nối Google Drive": browse folders,
 * find the spreadsheet, list its tabs. Read-only, and it exists so nobody has
 * to paste a folder id copied out of a browser address bar.
 *
 * It runs on the TENANT's OAuth token, never on the Service Account: the
 * service account has no "Drive của tôi" to show. So an unconnected tenant is
 * refused here with GOOGLE_NOT_CONNECTED — that is a screen state, not a bug.
 */

/** `root` is Drive's own alias for "Drive của tôi"; keep it verbatim. */
export const DRIVE_ROOT_ID = "root";
/** Long enough for a real folder name, short enough to bound the Drive query. */
const MAX_QUERY_LENGTH = 128;

export interface BrowseGoogleDriveInput {
  readonly tenantId: TenantId;
  readonly parentId?: string | null;
  readonly pageToken?: string | null;
  readonly q?: string | null;
}

export interface ListSheetTabsInput {
  readonly tenantId: TenantId;
  readonly spreadsheetId: string;
}

export interface BrowseGoogleDriveDeps {
  browser: GoogleDriveBrowser;
  oauth: GoogleOAuthRepo;
  logger: Logger;
}

export interface BrowseGoogleDrive {
  listFolders(input: BrowseGoogleDriveInput): Promise<ListGoogleFoldersResult>;
  listSpreadsheets(input: BrowseGoogleDriveInput): Promise<ListGoogleSpreadsheetsResult>;
  listSheetTabs(input: ListSheetTabsInput): Promise<readonly string[]>;
}

export function makeBrowseGoogleDrive(deps: BrowseGoogleDriveDeps): BrowseGoogleDrive {
  /**
   * One gate for all three operations: the picker may only ever run on a live
   * tenant connection. An integration parked in `error` is refused with the
   * code the screen turns into "kết nối lại", instead of a Drive 401 nobody can
   * read.
   */
  async function requireConnection(tenantId: TenantId, operation: string): Promise<void> {
    const connection = await deps.oauth.findConnection(tenantId);
    if (!connection) {
      throw new AppError("GOOGLE_NOT_CONNECTED", {
        message: "The tenant has no connected Google account to browse",
        context: { tenant_id: tenantId, operation, reason: "NOT_CONNECTED" },
      });
    }
    if (connection.status === "error") {
      throw new AppError("GOOGLE_AUTH_EXPIRED", {
        message: "The tenant's Google connection is marked as expired",
        context: { tenant_id: tenantId, operation, reason: "CONNECTION_EXPIRED" },
      });
    }
  }

  return {
    async listFolders(input) {
      // --- Edge cases first --------------------------------------------------
      const tenantId = requireTenant(input?.tenantId, "listFolders");
      const parentId = str(input?.parentId) || DRIVE_ROOT_ID;
      const q = requireQuery(input?.q, tenantId, "listFolders");
      await requireConnection(tenantId, "listFolders");

      const result = await deps.browser.listFolders({
        tenantId,
        parentId,
        pageToken: str(input?.pageToken) || null,
        q,
      });

      deps.logger.debug("Drive folder listing served", {
        tenant_id: tenantId,
        parent_id: parentId,
        items: result.items.length,
        has_more: result.nextPageToken !== null,
      });
      return result;
    },

    async listSpreadsheets(input) {
      const tenantId = requireTenant(input?.tenantId, "listSpreadsheets");
      // Absent parent = search the whole Drive; that is a documented mode of
      // the contract, not a missing parameter.
      const parentId = str(input?.parentId) || null;
      const q = requireQuery(input?.q, tenantId, "listSpreadsheets");
      await requireConnection(tenantId, "listSpreadsheets");

      const result = await deps.browser.listSpreadsheets({
        tenantId,
        parentId,
        pageToken: str(input?.pageToken) || null,
        q,
      });

      deps.logger.debug("Drive spreadsheet listing served", {
        tenant_id: tenantId,
        parent_id: parentId,
        items: result.items.length,
        has_more: result.nextPageToken !== null,
      });
      return result;
    },

    async listSheetTabs(input) {
      const tenantId = requireTenant(input?.tenantId, "listSheetTabs");
      const spreadsheetId = str(input?.spreadsheetId);
      if (spreadsheetId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listSheetTabs requires a spreadsheet id",
          userMessage: "Thiếu mã bảng Google Sheet.",
          context: { tenant_id: tenantId, reason: "SPREADSHEET_ID_MISSING" },
        });
      }
      await requireConnection(tenantId, "listSheetTabs");

      const tabs = await deps.browser.listSheetTabs({ tenantId, spreadsheetId });
      if (tabs.length === 0) {
        // Every spreadsheet has at least one tab, so an empty answer means we
        // are looking at something else (or at a truncated response).
        deps.logger.warn("Spreadsheet reported no tab at all", {
          tenant_id: tenantId,
          spreadsheet_id: spreadsheetId,
          reason: "NO_TABS",
        });
      }
      return tabs;
    },
  };
}

// --- helpers ----------------------------------------------------------------

function requireQuery(raw: unknown, tenantId: TenantId, operation: string): string | null {
  const q = str(raw);
  if (q.length === 0) return null;
  if (q.length > MAX_QUERY_LENGTH) {
    throw new AppError("INVALID_INPUT", {
      message: `Search text is longer than ${MAX_QUERY_LENGTH} characters`,
      userMessage: "Từ khoá tìm kiếm quá dài.",
      context: { tenant_id: tenantId, operation, length: q.length, reason: "QUERY_TOO_LONG" },
    });
  }
  return q;
}

function requireTenant(raw: TenantId | undefined, operation: string): TenantId {
  if (typeof raw !== "string" || !isTenantId(raw.trim())) {
    throw new AppError("INVALID_INPUT", {
      message: "Browsing Google Drive requires a tenant UUID",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: (typeof raw === "string" ? raw.trim() : "") || null, operation },
    });
  }
  return normalizeTenantId(raw);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
