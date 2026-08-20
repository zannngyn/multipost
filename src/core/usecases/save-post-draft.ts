import { AppError } from "@/core/domain/errors";
import {
  assertComposeDraftPayload,
  assertPostDraftAddress,
  POST_DRAFT_SCHEMA_VERSION,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * E10 — autosave of the compose screen: store what the operator typed so a
 * refresh does not throw it away.
 *
 * It validates before it writes, and it REFUSES instead of cleaning: a payload
 * carrying stock/price/note/URL keys means the client is about to persist
 * internal data (business rule 2), and quietly dropping the key would leave the
 * bug in place (business rule 5). The rejection is logged with the offending
 * key and path so the cause is readable without a debugger.
 *
 * Called on a timer, so it stays cheap: one validation, one upsert, no reads.
 */

export interface SavePostDraftInput {
  readonly tenantId: TenantId;
  /** app_user.id of the operator. Resolved by the caller, never guessed here. */
  readonly ownerUserId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
  /** Straight from the browser — untrusted until `assertComposeDraftPayload`. */
  readonly payload: unknown;
}

export interface SavePostDraftResult {
  /** ISO-8601, as written by the DB. The UI shows it as "Đã lưu nháp lúc ...". */
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export interface SavePostDraftDeps {
  drafts: PostDraftRepo;
  logger: Logger;
}

export function makeSavePostDraft(deps: SavePostDraftDeps) {
  return async function savePostDraft(input: SavePostDraftInput): Promise<SavePostDraftResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const address = assertPostDraftAddress(input);
    const log = deps.logger.child({
      tenant_id: address.tenantId,
      owner_user_id: address.ownerUserId,
      draft_kind: address.kind,
    });

    let payload;
    try {
      payload = assertComposeDraftPayload(input.payload);
    } catch (error) {
      // Logged HERE (with the reason) and rethrown: the route turns it into
      // 422/413, and the operator sees why the draft was refused.
      const appError = AppError.from(error, "DRAFT_PAYLOAD_REJECTED");
      log.warn("Draft save refused: payload failed validation", appError.toLogObject());
      throw appError;
    }

    // --- Happy path ----------------------------------------------------------
    // Repo failures are already AppError('DB_ERROR') from the adapter; letting
    // them propagate keeps one cause, one log line.
    const stored = await deps.drafts.save({
      tenantId: address.tenantId,
      ownerUserId: address.ownerUserId,
      kind: address.kind,
      payload,
      schemaVersion: POST_DRAFT_SCHEMA_VERSION,
    });

    log.debug("Draft saved", {
      schema_version: stored.schemaVersion,
      draft_step: payload.step,
      updated_at: stored.updatedAt.toISOString(),
    });

    return {
      updatedAt: stored.updatedAt.toISOString(),
      schemaVersion: stored.schemaVersion,
    };
  };
}

export type SavePostDraft = ReturnType<typeof makeSavePostDraft>;
