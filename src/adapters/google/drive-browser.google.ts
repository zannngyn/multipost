import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type {
  CheckGoogleSourceAccessInput,
  GoogleDriveBrowser,
  GoogleDriveEntry,
  GoogleSourceAccessState,
  ListGoogleFoldersInput,
  ListGoogleFoldersResult,
  ListGoogleSheetTabsInput,
  ListGoogleSpreadsheetsInput,
  ListGoogleSpreadsheetsResult,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

import { escapeQueryValue } from "./drive-query";
import type { TenantGoogleAuth } from "./tenant-google-auth";

/**
 * The in-app Drive picker (E2), on Drive API v3 `files.list` / `files.get` and
 * Sheets `spreadsheets.get`.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3
 *
 * Deliberately NOT Google Picker: the picker is a third-party iframe that needs
 * its own API key and browser origin, and it cannot run on the tenant's OAuth
 * token the rest of this feature already holds.
 *
 * Everything Drive answers is schema-validated before it becomes a row of the
 * picker; an entry without an id or a name is dropped with a counted warning.
 */

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
/** Drive's own alias for "Drive của tôi". */
const ROOT_ID = "root";
const ROOT_NAME = "Drive của tôi";
const PAGE_SIZE = 100;
/**
 * Ancestor hops the breadcrumb may climb. A Drive tree is never this deep; the
 * cap is there so a cyclic/looping `parents` chain cannot spin a request
 * forever (Drive allows multiple parents, and a shortcut graph can lie).
 */
const MAX_BREADCRUMB_DEPTH = 20;

const EntrySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  modifiedTime: z.string().nullish(),
});

const ListResponseSchema = z.object({
  files: z.array(z.unknown()).nullish(),
  nextPageToken: z.string().nullish(),
  incompleteSearch: z.boolean().nullish(),
});

const FileWithParentsSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  parents: z.array(z.string().trim().min(1)).nullish(),
});

const SpreadsheetTabsSchema = z.object({
  sheets: z
    .array(z.object({ properties: z.object({ title: z.string() }).partial().nullish() }))
    .nullish(),
});

export interface GoogleDriveBrowserDeps {
  auth: TenantGoogleAuth;
  logger: Logger;
}

export function makeGoogleDriveBrowser(deps: GoogleDriveBrowserDeps): GoogleDriveBrowser {
  const driveFor = async (tenantId: string) =>
    google.drive({ version: "v3", auth: await deps.auth.forTenant(tenantId) });
  const sheetsFor = async (tenantId: string) =>
    google.sheets({ version: "v4", auth: await deps.auth.forTenant(tenantId) });

  /** One mapping for every Drive failure of this file. Never leaks googleapis. */
  async function driveError(
    tenantId: string,
    operation: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): Promise<AppError> {
    const authError = await deps.auth.reportAuthFailure(tenantId, error);
    if (authError) return authError;

    const status = httpStatusOf(error);
    if (status === 404 || status === 403) {
      // The id is wrong, or the connected Google account cannot see it. Both
      // are the caller's problem to fix, not an outage to retry.
      return new AppError("INVALID_INPUT", {
        message: `Drive refused ${operation} with HTTP ${status}`,
        userMessage:
          "Không mở được mục này trên Google Drive — kiểm tra lại đường dẫn, hoặc tài khoản Google đã kết nối không có quyền xem.",
        context: { tenant_id: tenantId, operation, http_status: status, ...context },
        cause: error,
      });
    }
    return AppError.from(error, "DRIVE_ERROR", {
      tenant_id: tenantId,
      operation,
      http_status: status ?? null,
      ...context,
    });
  }

  /** Shared body of both listings: same shape, different `q` and ordering. */
  async function listEntries(args: {
    tenantId: string;
    query: string;
    orderBy: string;
    pageToken: string | null;
    operation: string;
    logContext: Record<string, unknown>;
  }): Promise<{ items: GoogleDriveEntry[]; nextPageToken: string | null }> {
    const drive = await driveFor(args.tenantId);

    let payload: unknown;
    try {
      const response = await drive.files.list({
        q: args.query,
        fields: "nextPageToken,files(id,name,modifiedTime)",
        orderBy: args.orderBy,
        pageSize: PAGE_SIZE,
        pageToken: args.pageToken ?? undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      payload = response.data;
    } catch (error) {
      throw await driveError(args.tenantId, args.operation, error, args.logContext);
    }

    const parsed = ListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError("DRIVE_ERROR", {
        message: `Drive ${args.operation} returned an unexpected payload shape`,
        context: {
          tenant_id: args.tenantId,
          operation: args.operation,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          ...args.logContext,
        },
      });
    }

    const log = deps.logger.child({ tenant_id: args.tenantId });
    if (parsed.data.incompleteSearch === true) {
      log.warn("Drive reported an incomplete search — the picker list may be partial", {
        operation: args.operation,
        ...args.logContext,
      });
    }

    const items: GoogleDriveEntry[] = [];
    let malformed = 0;
    for (const raw of parsed.data.files ?? []) {
      const entry = EntrySchema.safeParse(raw);
      if (!entry.success) {
        malformed += 1;
        continue;
      }
      items.push({ id: entry.data.id, name: entry.data.name });
    }
    if (malformed > 0) {
      log.warn("Drive returned picker entries without an id or a name", {
        operation: args.operation,
        malformed_entries: malformed,
        ...args.logContext,
      });
    }

    return { items, nextPageToken: parsed.data.nextPageToken ?? null };
  }

  /**
   * Root -> `parentId`. Climbs `parents` one hop at a time because Drive has no
   * "give me the path" call.
   *
   * A hop we cannot read (403/404) STOPS the walk with a warning instead of
   * failing the request: being allowed into a shared sub-folder while its
   * parents stay invisible is normal, and a breadcrumb is navigation, not data.
   */
  async function buildBreadcrumb(
    tenantId: string,
    parentId: string,
  ): Promise<GoogleDriveEntry[]> {
    const root: GoogleDriveEntry = { id: ROOT_ID, name: ROOT_NAME };
    if (parentId === ROOT_ID) return [root];

    const drive = await driveFor(tenantId);
    const seen = new Set<string>();
    const chain: GoogleDriveEntry[] = [];
    let current: string | null = parentId;

    for (let depth = 0; depth < MAX_BREADCRUMB_DEPTH && current; depth += 1) {
      if (seen.has(current)) {
        // Drive answered with a cycle. Stop and say so; do not spin.
        deps.logger.warn("Drive parent chain loops back on itself", {
          tenant_id: tenantId,
          folder_id: current,
          reason: "BREADCRUMB_CYCLE",
        });
        break;
      }
      seen.add(current);

      let payload: unknown;
      try {
        const response = await drive.files.get({
          fileId: current,
          fields: "id,name,parents",
          supportsAllDrives: true,
        });
        payload = response.data;
      } catch (error) {
        const status = httpStatusOf(error);
        if (status === 403 || status === 404) {
          deps.logger.warn("Cannot read a Drive ancestor — breadcrumb stops here", {
            tenant_id: tenantId,
            folder_id: current,
            http_status: status,
            reason: "BREADCRUMB_ANCESTOR_UNREADABLE",
          });
          break;
        }
        throw await driveError(tenantId, "drive.files.get", error, { folder_id: current });
      }

      const parsed = FileWithParentsSchema.safeParse(payload);
      if (!parsed.success) {
        deps.logger.warn("Drive returned an ancestor without an id or a name", {
          tenant_id: tenantId,
          folder_id: current,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          reason: "BREADCRUMB_ENTRY_INVALID",
        });
        break;
      }

      const parents = parsed.data.parents ?? [];
      if (parents.length === 0) {
        // No parent = this IS a drive root. It is represented by the `root`
        // entry prepended below, so it is not pushed twice.
        break;
      }
      chain.push({ id: parsed.data.id, name: parsed.data.name });
      current = parents[0] ?? null;
    }

    if (chain.length >= MAX_BREADCRUMB_DEPTH) {
      deps.logger.warn("Drive parent chain is deeper than the breadcrumb cap", {
        tenant_id: tenantId,
        folder_id: parentId,
        max_depth: MAX_BREADCRUMB_DEPTH,
        reason: "BREADCRUMB_TOO_DEEP",
      });
    }

    return [root, ...chain.reverse()];
  }

  return {
    async listFolders(input: ListGoogleFoldersInput): Promise<ListGoogleFoldersResult> {
      // --- Edge cases first --------------------------------------------------
      const tenantId = trim(input?.tenantId);
      const parentId = trim(input?.parentId) || ROOT_ID;
      if (tenantId.length === 0) throw missingTenant("listFolders");

      const clauses = [
        `'${escapeQueryValue(parentId)}' in parents`,
        `mimeType='${FOLDER_MIME}'`,
        "trashed=false",
      ];
      const q = trim(input?.q);
      // The quote in "Ảnh 'mẫu' 2026" must not close the literal and turn the
      // rest of the name into Drive query syntax.
      if (q.length > 0) clauses.push(`name contains '${escapeQueryValue(q)}'`);

      const listed = await listEntries({
        tenantId,
        query: clauses.join(" and "),
        orderBy: "folder,name",
        pageToken: trim(input?.pageToken) || null,
        operation: "drive.files.list",
        logContext: { parent_id: parentId },
      });

      return { ...listed, breadcrumb: await buildBreadcrumb(tenantId, parentId) };
    },

    async listSpreadsheets(
      input: ListGoogleSpreadsheetsInput,
    ): Promise<ListGoogleSpreadsheetsResult> {
      const tenantId = trim(input?.tenantId);
      if (tenantId.length === 0) throw missingTenant("listSpreadsheets");
      const parentId = trim(input?.parentId);

      const clauses = [`mimeType='${SPREADSHEET_MIME}'`, "trashed=false"];
      if (parentId.length > 0) clauses.unshift(`'${escapeQueryValue(parentId)}' in parents`);
      const q = trim(input?.q);
      if (q.length > 0) clauses.push(`name contains '${escapeQueryValue(q)}'`);

      return listEntries({
        tenantId,
        query: clauses.join(" and "),
        // Without a folder we are searching the whole Drive: what the operator
        // wants is almost always the sheet they touched last.
        orderBy: parentId.length > 0 ? "folder,name" : "modifiedTime desc",
        pageToken: trim(input?.pageToken) || null,
        operation: "drive.files.list",
        logContext: { parent_id: parentId || null, scope: "spreadsheets" },
      });
    },

    async listSheetTabs(input: ListGoogleSheetTabsInput): Promise<readonly string[]> {
      const tenantId = trim(input?.tenantId);
      const spreadsheetId = trim(input?.spreadsheetId);
      if (tenantId.length === 0) throw missingTenant("listSheetTabs");
      if (spreadsheetId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "listSheetTabs requires a spreadsheet id",
          userMessage: "Thiếu mã bảng Google Sheet.",
          context: { tenant_id: tenantId, reason: "SPREADSHEET_ID_MISSING" },
        });
      }

      const sheets = await sheetsFor(tenantId);
      let payload: unknown;
      try {
        const response = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: "sheets.properties.title",
        });
        payload = response.data;
      } catch (error) {
        const authError = await deps.auth.reportAuthFailure(tenantId, error);
        if (authError) throw authError;
        const status = httpStatusOf(error);
        if (status === 404 || status === 403) {
          throw new AppError("INVALID_INPUT", {
            message: `Sheets refused spreadsheets.get with HTTP ${status}`,
            userMessage:
              "Không mở được bảng Google Sheet này — kiểm tra lại đường dẫn, hoặc tài khoản Google đã kết nối không có quyền xem.",
            context: {
              tenant_id: tenantId,
              spreadsheet_id: spreadsheetId,
              operation: "sheets.spreadsheets.get",
              http_status: status,
            },
            cause: error,
          });
        }
        throw AppError.from(error, "SHEET_ERROR", {
          tenant_id: tenantId,
          spreadsheet_id: spreadsheetId,
          operation: "sheets.spreadsheets.get",
          http_status: status ?? null,
        });
      }

      const parsed = SpreadsheetTabsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError("SHEET_ERROR", {
          message: "Sheets spreadsheets.get returned an unexpected payload shape",
          context: {
            tenant_id: tenantId,
            spreadsheet_id: spreadsheetId,
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }

      const tabs: string[] = [];
      for (const sheet of parsed.data.sheets ?? []) {
        const title = trim(sheet?.properties?.title);
        if (title.length > 0) tabs.push(title);
      }
      return tabs;
    },

    async checkSourceAccess(input: CheckGoogleSourceAccessInput): Promise<GoogleSourceAccessState> {
      // --- Edge cases first --------------------------------------------------
      const tenantId = trim(input?.tenantId);
      if (tenantId.length === 0) throw missingTenant("checkSourceAccess");
      const folderId = trim(input?.driveFolderId);
      const spreadsheetId = trim(input?.spreadsheetId);
      // Nothing configured yet is the NORMAL first-connect state: the operator
      // is about to pick a source, and there is nothing to warn about.
      if (folderId.length === 0 && spreadsheetId.length === 0) return "no_source";

      const log = deps.logger.child({ tenant_id: tenantId });
      const skipped = Promise.resolve<ProbeResult>("skipped");
      const [drive, sheet] = await Promise.all([
        folderId.length === 0 ? skipped : probeDriveFolder(tenantId, folderId, log),
        spreadsheetId.length === 0 ? skipped : probeSpreadsheet(tenantId, spreadsheetId, log),
      ]);

      const state = combineProbes(drive, sheet);
      log.info("Checked whether the connected Google account can read the configured source", {
        drive_folder_id: folderId || null,
        spreadsheet_id: spreadsheetId || null,
        drive_probe: drive,
        spreadsheet_probe: sheet,
        source_access: state,
      });
      return state;
    },
  };

  async function probeDriveFolder(
    tenantId: string,
    folderId: string,
    log: Logger,
  ): Promise<ProbeResult> {
    try {
      // files.get, NOT files.list: an invisible folder makes files.list answer
      // HTTP 200 with an empty page, which is indistinguishable from an empty
      // folder — the exact confusion this whole check exists to remove.
      const drive = await driveFor(tenantId);
      await drive.files.get({ fileId: folderId, fields: "id", supportsAllDrives: true });
      return "ok";
    } catch (error) {
      return classifyProbeError(error, log, {
        operation: "drive.files.get",
        drive_folder_id: folderId,
      });
    }
  }

  async function probeSpreadsheet(
    tenantId: string,
    spreadsheetId: string,
    log: Logger,
  ): Promise<ProbeResult> {
    try {
      const sheets = await sheetsFor(tenantId);
      await sheets.spreadsheets.get({ spreadsheetId, fields: "spreadsheetId" });
      return "ok";
    } catch (error) {
      return classifyProbeError(error, log, {
        operation: "sheets.spreadsheets.get",
        spreadsheet_id: spreadsheetId,
      });
    }
  }

  /**
   * 403/404 = the account really cannot read it. Anything else (network, quota,
   * a grant that died between two calls) is NOT a verdict: it becomes
   * `inconclusive`, and the screen keeps saying "chưa kiểm tra được".
   *
   * `reportAuthFailure` is deliberately NOT called here: a probe must not park
   * the integration row in `error` — it runs right after a successful connect,
   * and a transient failure would undo it.
   */
  function classifyProbeError(
    error: unknown,
    log: Logger,
    context: Record<string, unknown>,
  ): ProbeResult {
    const status = httpStatusOf(error);
    if (status === 403 || status === 404) {
      log.warn("The connected Google account cannot read this source", {
        ...context,
        http_status: status,
        reason: "SOURCE_UNREADABLE",
      });
      return "unreadable";
    }
    log.warn("Source access check was inconclusive — reporting it as unknown", {
      ...context,
      http_status: status ?? null,
      reason: "SOURCE_CHECK_INCONCLUSIVE",
      err: AppError.from(error, "DRIVE_ERROR", context).toLogObject(),
    });
    return "inconclusive";
  }
}

/** One half of the source check. */
type ProbeResult = "ok" | "unreadable" | "inconclusive" | "skipped";

/**
 * Two halves -> one state. An `unreadable` half always wins over an
 * inconclusive one: a warning the operator can act on beats "chưa rõ".
 */
export function combineProbes(drive: ProbeResult, spreadsheet: ProbeResult): GoogleSourceAccessState {
  const driveBad = drive === "unreadable";
  const sheetBad = spreadsheet === "unreadable";
  if (driveBad && sheetBad) return "both_unreadable";
  if (driveBad) return "drive_unreadable";
  if (sheetBad) return "spreadsheet_unreadable";
  if (drive === "inconclusive" || spreadsheet === "inconclusive") return "unknown";
  return "ok";
}

// --- helpers ----------------------------------------------------------------

function missingTenant(operation: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: `${operation} requires a tenant id`,
    userMessage: "Mã đơn vị (tenant) không hợp lệ.",
    context: { tenant_id: null, operation },
  });
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

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
