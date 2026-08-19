import { AppError } from "@/core/domain/errors";
import { requireGoogleRef } from "@/core/domain/google-source-ref";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { GoogleDriveBrowser, GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Clock, Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import { checkAndRecordSourceAccess } from "./check-google-source-access";
import { toCatalogSourceView, type CatalogSourceView } from "./get-catalog-source";
import { resolveActorUserId } from "./resolve-actor";

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
  readonly tenantId: string;
  /** Drive folder URL or bare id. */
  readonly driveFolder: string;
  /** Spreadsheet URL or bare id. */
  readonly spreadsheet: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName: string;
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
    const tenantId = str(input?.tenantId);
    if (!isTenantId(tenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "updateCatalogSource requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: tenantId || null },
      });
    }

    // Each throws INVALID_INPUT naming its own field, so the form can highlight
    // the box the operator pasted into.
    const driveFolderId = requireGoogleRef("drive_folder", "driveFolder", input?.driveFolder);
    const spreadsheetId = requireGoogleRef("spreadsheet", "spreadsheet", input?.spreadsheet);
    const sheetName = normaliseSheetName(input?.sheetName, tenantId);

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
      source: { driveFolderId, spreadsheetId, sheetName },
      actorUserId,
      actorEmail,
    });

    const changed =
      previous === null ||
      previous.driveFolderId !== driveFolderId ||
      previous.spreadsheetId !== spreadsheetId ||
      previous.sheetName !== sheetName;

    // info, not debug: "vì sao hôm nay đồng bộ ra 40 sản phẩm" is answered by
    // this line plus the next sync run.
    log.info("Catalog source updated", {
      actor_email: actorEmail,
      actor_user_id: actorUserId,
      changed,
      previous: previous
        ? {
            drive_folder_id: previous.driveFolderId,
            spreadsheet_id: previous.spreadsheetId,
            sheet_name: previous.sheetName,
          }
        : null,
      next: {
        drive_folder_id: driveFolderId,
        spreadsheet_id: spreadsheetId,
        sheet_name: sheetName,
      },
      note: changed ? "catalog is stale until the next sync" : "no change",
    });

    // The stored verdict describes the OLD source; after a change it is a lie
    // either way it points. Re-probed with the identity in use — including the
    // picker path, where the answer is almost certainly `ok`: two Drive calls
    // are cheaper than trusting a "đã duyệt rồi" flag that arrives from the
    // browser (CLAUDE.md technical rule 2 — do not trust outside data).
    // No-op for a tenant on the Service Account: the repo writes nothing when
    // there is no connection.
    if (changed && deps.oauth && deps.browser && deps.clock) {
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
        { driveFolderId, spreadsheetId, sheetName },
      );
    }

    return toCatalogSourceView({ driveFolderId, spreadsheetId, sheetName });
  };
}

export type UpdateCatalogSource = ReturnType<typeof makeUpdateCatalogSource>;

function normaliseSheetName(raw: unknown, tenantId: string): string {
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
