import { AppError } from "@/core/domain/errors";
import { requireGoogleRef } from "@/core/domain/google-source-ref";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

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
 * Nothing here validates that Google can actually READ the new source: the
 * Service Account may be granted access minutes later, and refusing to save
 * would leave the operator with no way to record the id at all. The next sync is
 * where a permission problem surfaces, with DRIVE_ERROR/SHEET_ERROR.
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
