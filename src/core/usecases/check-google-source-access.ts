import { AppError } from "@/core/domain/errors";
import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";
import type {
  GoogleDriveBrowser,
  GoogleOAuthRepo,
  GoogleSourceAccessState,
} from "@/core/ports/google-oauth";
import type { Clock, Logger } from "@/core/ports/infra";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * "Can the account this tenant connected actually READ the folder and the sheet
 * it is configured with?" — computed at the two moments the answer can change
 * (a new connection, a new source) and stored, because the sync screen polls
 * and a Drive/Sheets call per poll would burn quota for nothing.
 *
 * Why it exists at all: connecting Google and choosing a source are separate
 * actions. A tenant running on the Service Account can connect a personal
 * account that sees the spreadsheet (it is theirs) but NOT the photo folder
 * (shared only with the service account). Drive reports that as an empty
 * folder, not as a permission error — the exact input the catalog sync used to
 * turn into "delete every photo".
 *
 * This is the WARNING half of that story. The half that actually prevents data
 * loss is the empty-source guard in `sync-catalog`, which also covers tenants
 * that never connected anything.
 */

export interface SourceAccessDeps {
  catalogConfig: CatalogConfigRepo;
  browser: GoogleDriveBrowser;
  oauth: GoogleOAuthRepo;
  clock: Clock;
}

/**
 * Never throws, never blocks its caller: the worst case is `"unknown"`, which
 * the screen shows as "chưa kiểm tra được" — the honest answer. Failing the
 * connect (or the source save) over a probe would be a cure worse than the
 * disease.
 *
 * Returns the state it stored, so the caller can put it straight in its view.
 */
export async function checkAndRecordSourceAccess(
  deps: SourceAccessDeps,
  tenantId: TenantId,
  log: Logger,
  /**
   * The source to check, when the caller just wrote it. Passing it avoids a
   * read-after-write of the row that was updated one line earlier — the caller
   * knows the answer better than a second SELECT does.
   */
  knownSource?: CatalogSourceConfig | null,
): Promise<GoogleSourceAccessState> {
  const state = await probe(deps, tenantId, log, knownSource);

  try {
    // A no-op for a tenant with no connection — the key describes a connected
    // account, so a Service Account tenant must not grow one.
    await deps.oauth.saveSourceAccess({
      tenantId,
      state,
      checkedAt: new Date(deps.clock.nowMs()).toISOString(),
    });
  } catch (error) {
    // Not rethrown ON PURPOSE, and only here: the connection/source IS saved,
    // and losing the bookkeeping of a warning must not undo the operator's
    // action. It stays visible as a warning with its full context.
    log.warn("Could not store the source-access result — the screen will say 'chưa rõ'", {
      tenant_id: tenantId,
      source_access: state,
      reason: "SOURCE_ACCESS_NOT_STORED",
      err: AppError.from(error, "DB_ERROR", { tenant_id: tenantId }).toLogObject(),
    });
  }

  return state;
}

async function probe(
  deps: SourceAccessDeps,
  tenantId: TenantId,
  log: Logger,
  knownSource?: CatalogSourceConfig | null,
): Promise<GoogleSourceAccessState> {
  let source: CatalogSourceConfig | null;
  if (knownSource !== undefined) {
    source = knownSource;
  } else {
    try {
      source = await deps.catalogConfig.findCatalogSource(tenantId);
    } catch (error) {
      log.warn("Could not read the configured source to check it — reporting 'unknown'", {
        tenant_id: tenantId,
        reason: "SOURCE_LOOKUP_FAILED",
        err: AppError.from(error, "DB_ERROR", { tenant_id: tenantId }).toLogObject(),
      });
      return "unknown";
    }
  }

  // Nothing configured yet: the normal state right after a first connect. The
  // operator is on their way to the picker; there is nothing to warn about.
  if (!source) return "no_source";

  try {
    return await deps.browser.checkSourceAccess({
      tenantId,
      driveFolderId: source.driveFolderId,
      spreadsheetId: source.spreadsheetId,
    });
  } catch (error) {
    // The adapter turns 403/404 into a verdict; anything reaching here (an
    // expired grant, a network failure, a missing OAuth app) is inconclusive.
    log.warn("Source-access check could not be completed — reporting 'unknown'", {
      tenant_id: tenantId,
      drive_folder_id: source.driveFolderId,
      spreadsheet_id: source.spreadsheetId,
      reason: "SOURCE_CHECK_FAILED",
      err: AppError.from(error, "DRIVE_ERROR", { tenant_id: tenantId }).toLogObject(),
    });
    return "unknown";
  }
}
