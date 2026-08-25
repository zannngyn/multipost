import {
  makeFieldMap,
  validateFieldMap,
  validateStockPolicy,
  type CatalogFieldMap,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import {
  validateCatalogTextConfig,
  type CatalogTextConfig,
} from "@/core/domain/catalog-text-config";
import { AppError } from "@/core/domain/errors";
import { requireGoogleRef } from "@/core/domain/google-source-ref";
import { validateMediaProfile, type MediaProfile } from "@/core/domain/media-profile";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { GoogleDriveBrowser, GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Clock, Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import { checkAndRecordSourceAccess } from "./check-google-source-access";
import { toCatalogSourceView, type CatalogSourceView } from "./get-catalog-source";
import { resolveActorUserId } from "./resolve-actor";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E2 — point this tenant at another Drive folder / Sheet from the UI.
 *
 * Accepts what an operator actually has: the URL from the address bar, or the
 * bare id. Parsing lives in `core/domain/google-source-ref` and is strict about
 * the host, because a wrong-but-plausible link is otherwise only discovered as
 * an empty sync hours later.
 *
 * IMPORTANT — saving does NOT sync. The catalog in the database still describes
 * the OLD source until someone runs a sync, and that next sync will `deleteStale`
 * every product and media row the new source does not contain (existing
 * sync-catalog behaviour: rows not stamped by the latest run are removed). In
 * other words, changing the source and syncing replaces the catalog wholesale —
 * post jobs already created keep their own copies, but the picker changes
 * completely. The UI warns about it; this usecase deliberately does not block,
 * because "sửa lại link vừa dán sai" must stay possible.
 *
 * Saving never FAILS over readability: the Service Account may be granted access
 * minutes later, and refusing to save would leave the operator with no way to
 * record the id at all. A connected tenant does get the source re-probed
 * afterwards, but only to refresh the warning on the screen — the answer is
 * stored, never a blocker. A permission problem still surfaces at the next sync,
 * where the empty-source guard stops it from deleting anything.
 */

const MAX_SHEET_NAME_LENGTH = 100;

export interface UpdateCatalogSourceInput {
  readonly tenantId: TenantId;
  /**
   * Drive folder URL or bare id.
   *
   * Three distinct requests, and they must not be collapsed (F3):
   *   absent / undefined -> keep whatever is stored,
   *   a value           -> parse it and replace,
   *   ""                -> clear it (only legal for a tenant reading a file).
   *
   * "Bắt buộc phải có" is NOT decided here: the repo checks the state AFTER the
   * merge, under its lock, so a tenant on a Google tab can never END UP with a
   * blank coordinate whether this call blanked it or it was already missing.
   */
  readonly driveFolder?: string;
  /** Spreadsheet URL or bare id. Same three meanings as `driveFolder`. */
  readonly spreadsheet?: string;
  /** Tab name, e.g. "Mẫu 2026". Same three meanings as `driveFolder`. */
  readonly sheetName?: string;
  /**
   * Column mapping of THIS tenant's sheet (onboarding phase 1).
   *
   * Absent = keep whatever is stored (the repo preserves it), which is what an
   * operator fixing a folder id expects. Present = replaces it wholesale, after
   * validation. It is NEVER partially merged: a half-map is how a caption ends
   * up reading a price column.
   */
  readonly fieldMap?: CatalogFieldMap | null;
  /** Stock policy. Absent = keep what is stored. `disabled` needs its reason. */
  readonly stockPolicy?: StockPolicy | null;
  /**
   * Where this tenant's photos are (onboarding phase 2). Absent = keep what is
   * stored; the repo preserves it, exactly like `fieldMap`.
   */
  readonly mediaProfile?: MediaProfile | null;
  /**
   * WHERE THE PRODUCT TEXT COMES FROM (onboarding phase 3). Absent = keep what
   * is stored, like the three above.
   *
   * ONLY `{ kind: "google_sheet" }` is accepted here. Two directions, two
   * doors:
   *   - switching TO an uploaded file goes through `uploadCatalogFile`, which
   *     reads the bytes first and mints the `storageKey` itself. That is the
   *     only code that can produce a stored file, so it is the only code
   *     allowed to point a tenant at one — otherwise a caller could aim a
   *     tenant at a key of its own invention;
   *   - switching BACK to a tab is this usecase's job: it needs no stored
   *     artefact, only the three coordinates.
   * Anything with `kind: "file"` is refused here with a coded error that names
   * the right door (see `normaliseTextConfig`).
   */
  readonly textConfig?: CatalogTextConfig | null;
  /**
   * Header row read from the sheet, when the caller has one (the compatibility
   * report has). Given it, a map pointing at a column that does not exist is
   * refused here instead of at the next sync.
   */
  readonly sheetColumns?: readonly string[] | null;
  readonly actorEmail?: string | null;
  readonly actorUserId?: string | null;
}

export interface UpdateCatalogSourceDeps {
  catalogConfig: CatalogConfigRepo;
  logger: Logger;
  /** Optional: without it the audit row carries the e-mail but no actor id. */
  users?: UserRepo;
  /**
   * Optional trio for the source-access recheck. Wired together or not at all;
   * without them the stored `sourceAccess` simply keeps its previous value —
   * which is why they are optional: a test that only cares about parsing must
   * not have to fake a Drive.
   */
  oauth?: GoogleOAuthRepo;
  browser?: GoogleDriveBrowser;
  clock?: Clock;
}

export function makeUpdateCatalogSource(deps: UpdateCatalogSourceDeps) {
  return async function updateCatalogSource(
    input: UpdateCatalogSourceInput,
  ): Promise<CatalogSourceView> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = str(input?.tenantId);
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "updateCatalogSource requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const textConfig = normaliseTextConfig(input?.textConfig, tenantId);

    // ONE treatment for all three coordinates, whichever source the tenant
    // reads: parse what was sent, pass "" through as an explicit clear, and
    // leave what was NOT sent out of the patch entirely.
    //
    // Nothing is read from the database here on purpose. Deciding "is this
    // field required?" needs the stored source, a read that would happen
    // outside the write transaction — and acting on it is exactly the lost
    // update F3 was (the value read before a concurrent save committed). The
    // repo owns that decision now: it merges under its lock and refuses a
    // Google tenant that would end up with a blank coordinate.
    const driveFolderId = patchGoogleRef(
      "drive_folder",
      "driveFolder",
      input?.driveFolder,
      tenantId,
    );
    const spreadsheetId = patchGoogleRef(
      "spreadsheet",
      "spreadsheet",
      input?.spreadsheet,
      tenantId,
    );
    const sheetName = patchSheetName(input?.sheetName, tenantId);
    // Validated BEFORE the write: an unusable map stored is a sync that dies
    // later, far from the operator who typed it.
    const fieldMap = normaliseFieldMap(input?.fieldMap, input?.sheetColumns, tenantId);
    const stockPolicy = normaliseStockPolicy(input?.stockPolicy, tenantId);
    const mediaProfile = normaliseMediaProfile(input?.mediaProfile, tenantId);

    const log = deps.logger.child({ tenant_id: tenantId });
    const actorEmail = str(input?.actorEmail).toLowerCase() || null;
    const actorUserId = await resolveActorUserId(
      { users: deps.users },
      tenantId,
      { actorUserId: input?.actorUserId ?? null, actorEmail },
      log,
    );

    const { previous } = await deps.catalogConfig.saveCatalogSource({
      tenantId,
      source: {
        // Omitted keys mean "keep what is stored" (port contract) — a folder fix
        // must not wipe a mapping built during onboarding, and a mapping fix
        // must not revert a folder someone else just moved.
        ...(driveFolderId !== undefined ? { driveFolderId } : {}),
        ...(spreadsheetId !== undefined ? { spreadsheetId } : {}),
        ...(sheetName !== undefined ? { sheetName } : {}),
        ...(fieldMap ? { fieldMap } : {}),
        ...(stockPolicy ? { stockPolicy } : {}),
        ...(mediaProfile ? { mediaProfile } : {}),
        ...(textConfig ? { textSource: textConfig } : {}),
      },
      actorUserId,
      actorEmail,
    });

    // What this tenant will actually run with from now on: what was just sent,
    // or what the repo kept because nothing was sent.
    // The three coordinates AFTER the write: what this call sent, else what the
    // repo reported as previous — and `previous` was read under the lock inside
    // the write transaction, so it is the value this save actually merged with.
    const effectiveDriveFolderId = driveFolderId ?? previous?.driveFolderId ?? "";
    const effectiveSpreadsheetId = spreadsheetId ?? previous?.spreadsheetId ?? "";
    const effectiveSheetName = sheetName ?? previous?.sheetName ?? "";
    const effectiveFieldMap = fieldMap ?? previous?.fieldMap ?? null;
    const effectiveStockPolicy = stockPolicy ?? previous?.stockPolicy ?? null;
    const effectiveMediaProfile = mediaProfile ?? previous?.mediaProfile ?? null;
    const effectiveTextConfig = textConfig ?? previous?.textSource ?? null;

    // Compared on the EFFECTIVE values: a patch that omits a coordinate did not
    // change it, and must not be logged as a source change.
    const sourceChanged =
      previous === null ||
      previous.driveFolderId !== effectiveDriveFolderId ||
      previous.spreadsheetId !== effectiveSpreadsheetId ||
      previous.sheetName !== effectiveSheetName;
    // Named separately: "cột nào đổi" and "đổi thư mục" are two different
    // incidents when a sync later comes back with 40 products instead of 300.
    const fieldMapChanged =
      fieldMap !== null && !sameFieldMap(previous?.fieldMap ?? null, fieldMap);
    const stockPolicyChanged =
      stockPolicy !== null &&
      JSON.stringify(previous?.stockPolicy ?? null) !== JSON.stringify(stockPolicy);
    const mediaProfileChanged =
      mediaProfile !== null &&
      JSON.stringify(previous?.mediaProfile ?? null) !== JSON.stringify(mediaProfile);
    // A source SWITCH (tab -> file, or a new file) is its own incident: it
    // changes which table every later sync reads.
    const textSourceChanged =
      textConfig !== null &&
      JSON.stringify(previous?.textSource ?? null) !== JSON.stringify(textConfig);
    const changed =
      sourceChanged ||
      fieldMapChanged ||
      stockPolicyChanged ||
      mediaProfileChanged ||
      textSourceChanged;

    // info, not debug: "vì sao hôm nay đồng bộ ra 40 sản phẩm" is answered by
    // this line plus the next sync run.
    log.info("Catalog source updated", {
      actor_email: actorEmail,
      actor_user_id: actorUserId,
      changed,
      source_changed: sourceChanged,
      field_map_changed: fieldMapChanged,
      stock_policy_changed: stockPolicyChanged,
      media_profile_changed: mediaProfileChanged,
      text_source_changed: textSourceChanged,
      previous: previous
        ? {
            drive_folder_id: previous.driveFolderId,
            spreadsheet_id: previous.spreadsheetId,
            sheet_name: previous.sheetName,
            field_map: previous.fieldMap ?? null,
            stock_policy_mode: previous.stockPolicy?.mode ?? null,
            media_profile_kind: previous.mediaProfile?.kind ?? null,
            text_source_kind: previous.textSource?.kind ?? null,
          }
        : null,
      next: {
        drive_folder_id: effectiveDriveFolderId,
        spreadsheet_id: effectiveSpreadsheetId,
        sheet_name: effectiveSheetName,
        // What this call actually sent, so a log line separates "đổi thành X"
        // from "không gửi, giữ nguyên X".
        sent: {
          drive_folder_id: driveFolderId ?? null,
          spreadsheet_id: spreadsheetId ?? null,
          sheet_name: sheetName ?? null,
        },
        field_map: fieldMap,
        stock_policy_mode: stockPolicy?.mode ?? null,
        media_profile_kind: mediaProfile?.kind ?? null,
        text_source_kind: effectiveTextConfig?.kind ?? "google_sheet",
      },
      note: changed ? "catalog is stale until the next sync" : "no change",
    });

    if (stockPolicy?.mode === "disabled") {
      // The one setting that suspends business rule 3 — never only in a debug
      // line, and never without the reason its author had to write down.
      log.warn("Stock check turned OFF for this tenant", {
        error_code: "STOCK_CHECK_DISABLED",
        actor_email: actorEmail,
        actor_user_id: actorUserId,
        stock_policy_reason: stockPolicy.reason,
      });
    }

    // The stored verdict describes the OLD source; after a change it is a lie
    // either way it points. Re-probed with the identity in use — including the
    // picker path, where the answer is almost certainly `ok`: two Drive calls
    // are cheaper than trusting a "đã duyệt rồi" flag that arrives from the
    // browser (CLAUDE.md technical rule 2 — do not trust outside data).
    // No-op for a tenant on the Service Account: the repo writes nothing when
    // there is no connection.
    // `sourceChanged`, not `changed`: re-mapping columns cannot alter whether
    // the connected account can READ the folder, so it must not cost two Drive
    // calls.
    if (
      sourceChanged &&
      effectiveDriveFolderId.length > 0 &&
      deps.oauth &&
      deps.browser &&
      deps.clock
    ) {
      await checkAndRecordSourceAccess(
        {
          catalogConfig: deps.catalogConfig,
          browser: deps.browser,
          oauth: deps.oauth,
          clock: deps.clock,
        },
        tenantId,
        log,
        // The source we JUST wrote — no read-after-write of the row updated one
        // line above.
        {
          driveFolderId: effectiveDriveFolderId,
          spreadsheetId: effectiveSpreadsheetId,
          sheetName: effectiveSheetName,
        },
      );
    }

    // The EFFECTIVE state after this write, so the UI can swap this response
    // into the state a GET produced (the docblock of toCatalogSourceView).
    // Untouched keys keep the value the repo preserved — `previous` was read
    // inside the same locked transaction, so it is the current one.
    // Caveat: a stored blob that did not parse comes back as `previous: null`
    // here, and this response then says "chưa khai" — which is exactly what the
    // next GET will say too (findCatalogSource returns null for it).
    return toCatalogSourceView({
      driveFolderId: effectiveDriveFolderId,
      spreadsheetId: effectiveSpreadsheetId,
      sheetName: effectiveSheetName,
      ...(effectiveFieldMap ? { fieldMap: effectiveFieldMap } : {}),
      ...(effectiveStockPolicy ? { stockPolicy: effectiveStockPolicy } : {}),
      ...(effectiveMediaProfile ? { mediaProfile: effectiveMediaProfile } : {}),
      ...(effectiveTextConfig ? { textSource: effectiveTextConfig } : {}),
    });
  };
}

export type UpdateCatalogSource = ReturnType<typeof makeUpdateCatalogSource>;

/**
 * One coordinate of the patch:
 *
 *   undefined / null -> undefined: the key is left out and the repo keeps the
 *                       stored value,
 *   ""               -> passed through as an explicit clear,
 *   a string         -> parsed strictly, so the form can highlight the box that
 *                       was pasted into,
 *   anything else    -> a coded error.
 *
 * The last line is the point: `str()` answers "" for a number, an object or a
 * boolean, and "" is a COMMAND here ("xoá toạ độ"). Silently turning a
 * wrong-typed field into a deletion is exactly the "fail validation -> quietly
 * use a default" that technical rule 2 forbids. The route's zod already refuses
 * non-strings, but a guard that only exists in one caller's schema is a
 * convention, not a rule (same reasoning as the `kind: "file"` refusal below).
 */
function requirePatchString(raw: unknown, field: string, tenantId: TenantId): string {
  if (typeof raw === "string") return raw;
  throw new AppError("INVALID_INPUT", {
    message: `${field} must be a string when present`,
    userMessage: "Giá trị gửi lên cho nguồn dữ liệu không hợp lệ.",
    context: {
      tenant_id: tenantId,
      field,
      reason: "PATCH_VALUE_NOT_A_STRING",
      received: typeof raw,
      issues: [{ path: field, message: "Giá trị gửi lên cho nguồn dữ liệu không hợp lệ." }],
    },
  });
}

function patchGoogleRef(
  kind: Parameters<typeof requireGoogleRef>[0],
  field: string,
  raw: unknown,
  tenantId: TenantId,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requirePatchString(raw, field, tenantId).trim();
  if (value.length === 0) return "";
  return requireGoogleRef(kind, field, value);
}

/** Same four cases for the tab name. */
function patchSheetName(raw: unknown, tenantId: TenantId): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requirePatchString(raw, "sheetName", tenantId).trim();
  if (value.length === 0) return "";
  return normaliseSheetName(value, tenantId);
}

/**
 * Validates the text source, or returns null for "không gửi thì giữ nguyên".
 *
 * THIS USECASE ONLY ACCEPTS `kind: "google_sheet"`. Pointing a tenant AT a file
 * means a stored file has to exist, and the only code that can produce one is
 * `uploadCatalogFile`: it reads the bytes first and mints the `storageKey`
 * itself. Letting this path take a `storageKey` would let a caller aim a tenant
 * at a key of their own invention — the sync then dies with
 * CATALOG_FILE_MISSING, and until it does the screen shows a `fileName` and an
 * `uploadedAt` that describe nothing.
 *
 * The rule used to live in the route's zod schema, which is a convention the
 * next caller (a platform-admin route, an operations script) does not inherit.
 * Here it is enforced by the usecase and covered by tests.
 *
 * Switching BACK from a file to a tab is the legal direction and goes through
 * here: it needs no stored artefact, only the three coordinates.
 */
function normaliseTextConfig(
  raw: CatalogTextConfig | null | undefined,
  tenantId: TenantId,
): CatalogTextConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") {
    throw new AppError("INVALID_INPUT", {
      message: "textConfig must be an object",
      userMessage: "Nguồn dữ liệu sản phẩm không hợp lệ.",
      context: { tenant_id: tenantId, field: "textConfig" },
    });
  }

  if ((raw as { kind?: unknown }).kind === "file") {
    throw new AppError("INVALID_INPUT", {
      message: "updateCatalogSource cannot point a tenant at a file; use uploadCatalogFile",
      userMessage:
        "Chuyển sang dùng file dữ liệu phải làm bằng cách tải file .csv lên (màn Nguồn dữ liệu → Tải file lên), không đặt trực tiếp ở đây.",
      context: {
        tenant_id: tenantId,
        field: "textConfig",
        reason: "TEXT_SOURCE_FILE_NOT_SETTABLE_HERE",
        kind: "file",
      },
    });
  }

  const issues = validateCatalogTextConfig(raw);
  if (issues.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `textConfig is unusable: ${issues.map((issue) => issue.code).join(", ")}`,
      userMessage: issues.map((issue) => issue.detail).join(" "),
      context: {
        tenant_id: tenantId,
        field: "textConfig",
        kind: (raw as { kind?: unknown }).kind ?? null,
        issues: issues.map((issue) => issue.code),
      },
    });
  }

  return raw;
}

function normaliseSheetName(raw: unknown, tenantId: TenantId): string {
  const value = str(raw);
  if (value.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "sheetName must not be empty",
      userMessage: "Nhập tên tab của Google Sheet (ví dụ: Mẫu 2026).",
      context: { tenant_id: tenantId, field: "sheetName" },
    });
  }
  if (value.length > MAX_SHEET_NAME_LENGTH) {
    throw new AppError("INVALID_INPUT", {
      message: `sheetName must be at most ${MAX_SHEET_NAME_LENGTH} characters`,
      userMessage: `Tên tab quá dài (tối đa ${MAX_SHEET_NAME_LENGTH} ký tự).`,
      context: { tenant_id: tenantId, field: "sheetName", length: value.length },
    });
  }
  return value;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates the column mapping the operator picked, or returns null for "không
 * gửi lên thì giữ nguyên cái đang lưu".
 *
 * Errors carry the tenant's own column names because that is what the operator
 * sees on screen. Warnings (a caption field on a price-looking column) do NOT
 * block: it can be deliberate, and the report already flags it.
 */
function normaliseFieldMap(
  raw: CatalogFieldMap | null | undefined,
  sheetColumns: readonly string[] | null | undefined,
  tenantId: TenantId,
): CatalogFieldMap | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") {
    throw new AppError("INVALID_INPUT", {
      message: "fieldMap must be an object",
      userMessage: "Bảng chọn cột không hợp lệ.",
      context: { tenant_id: tenantId, field: "fieldMap" },
    });
  }

  const fieldMap = makeFieldMap(raw);
  const issues = validateFieldMap(fieldMap, sheetColumns ?? []);
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `fieldMap is unusable: ${blocking.map((issue) => issue.code).join(", ")}`,
      userMessage: blocking.map((issue) => issue.detail).join(" "),
      context: {
        tenant_id: tenantId,
        field: "fieldMap",
        issues: blocking.map((issue) => issue.code),
      },
    });
  }

  return fieldMap;
}

/** Same contract as above for the stock policy. `disabled` needs its reason. */
function normaliseStockPolicy(
  raw: StockPolicy | null | undefined,
  tenantId: TenantId,
): StockPolicy | null {
  if (raw === undefined || raw === null) return null;

  const issues = validateStockPolicy(raw);
  if (issues.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `stockPolicy is unusable: ${issues.map((issue) => issue.code).join(", ")}`,
      userMessage: issues.map((issue) => issue.detail).join(" "),
      context: {
        tenant_id: tenantId,
        field: "stockPolicy",
        mode: (raw as { mode?: unknown })?.mode ?? null,
        issues: issues.map((issue) => issue.code),
      },
    });
  }

  return raw;
}

/** Same contract as above for the media profile. Colour issues never block. */
function normaliseMediaProfile(
  raw: MediaProfile | null | undefined,
  tenantId: TenantId,
): MediaProfile | null {
  if (raw === undefined || raw === null) return null;

  const blocking = validateMediaProfile(raw).filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `mediaProfile is unusable: ${blocking.map((issue) => issue.code).join(", ")}`,
      userMessage: blocking.map((issue) => issue.detail).join(" "),
      context: {
        tenant_id: tenantId,
        field: "mediaProfile",
        kind: (raw as { kind?: unknown })?.kind ?? null,
        issues: blocking.map((issue) => issue.code),
      },
    });
  }

  return raw;
}

function sameFieldMap(a: CatalogFieldMap | null, b: CatalogFieldMap | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(makeFieldMap(a)) === JSON.stringify(makeFieldMap(b));
}
