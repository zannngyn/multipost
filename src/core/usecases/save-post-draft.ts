import { AppError } from "@/core/domain/errors";
import {
  assertComposeDraftPayload,
  POST_DRAFT_NOT_PERSISTED,
  POST_DRAFT_SCHEMA_VERSION,
  type PostDraftNotPersisted,
  type PostDraftOwnerInput,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";
import type { UserRepo } from "@/core/ports/user-repo";

import { resolveDraftAddress } from "./resolve-draft-owner";

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
 * It also owns the "who does this draft belong to?" decision: an operator with
 * no `app_user` row gets `persisted: false`, never a save that looks successful.
 *
 * Called on a timer, so it stays cheap: one owner lookup, one validation, one
 * upsert, no reads.
 */

export interface SavePostDraftInput extends PostDraftOwnerInput {
  readonly tenantId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
  /** Straight from the browser — untrusted until `assertComposeDraftPayload`. */
  readonly payload: unknown;
}

export interface SavedPostDraft {
  readonly persisted: true;
  /** `app_user.id` the row is addressed by — the caller scopes its local buffer with it. */
  readonly ownerUserId: string;
  /** ISO-8601, as written by the DB. The UI shows it as "Đã lưu nháp lúc ...". */
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

/** Discriminated on `persisted`: there is no "saved, maybe" answer. */
export type SavePostDraftResult = SavedPostDraft | PostDraftNotPersisted;

export interface SavePostDraftDeps {
  drafts: PostDraftRepo;
  /** Resolves the session e-mail to the `app_user.id` a draft is owned by. */
  users?: UserRepo;
  logger: Logger;
}

export function makeSavePostDraft(deps: SavePostDraftDeps) {
  return async function savePostDraft(input: SavePostDraftInput): Promise<SavePostDraftResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const { address, log } = await resolveDraftAddress(deps, input, "save");

    // No owner: nothing to address a row to. Answered, not thrown — the draft
    // lives on in the browser and the screen says "chỉ lưu trên máy này".
    // A FAILED lookup lands here too, deliberately: an autosave that cannot name
    // the owner has written nothing and says so, and the operator loses nothing
    // because the local buffer still holds the draft. `resolveDraftAddress` logs
    // which of the two happened (NO_USER vs LOOKUP_FAILED) with the DB error.
    if (!address) return POST_DRAFT_NOT_PERSISTED;

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
      persisted: true,
      ownerUserId: address.ownerUserId,
      updatedAt: stored.updatedAt.toISOString(),
      schemaVersion: stored.schemaVersion,
    };
  };
}

export type SavePostDraft = ReturnType<typeof makeSavePostDraft>;
