import {
  POST_DRAFT_NOT_PERSISTED,
  type PostDraftNotPersisted,
  type PostDraftOwnerInput,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";
import type { UserRepo } from "@/core/ports/user-repo";

import { POST_DRAFT_OWNER_LOOKUP_FAILED, resolveDraftAddress } from "./resolve-draft-owner";

/**
 * E10 — drops the compose draft: after a batch is created (the draft became a
 * real post) and when the operator presses "Xoá nháp".
 *
 * Idempotent by contract: deleting a draft that is not there is success, not an
 * error. The caller is often a cleanup path running after a redirect, and a
 * throw there would surface as a scary message about work that already
 * completed. An operator with no `app_user` row has no row to delete either —
 * same outcome, reported as `persisted: false` rather than invented as failure.
 *
 * Idempotence stops exactly where knowledge stops: when the OWNER LOOKUP itself
 * fails we do not know whether a row exists, so this usecase throws instead of
 * answering "gone". Reporting success there is the worst lie available — the
 * client drops its pending-discard marker, and the draft the operator deleted is
 * offered again on the next mount (business rule 5).
 */

export interface DiscardPostDraftInput extends PostDraftOwnerInput {
  readonly tenantId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
}

export interface DiscardedPostDraft {
  /** True = the server-side draft of this owner was addressed and is now gone. */
  readonly persisted: true;
  readonly ownerUserId: string;
}

/** Discriminated on `persisted`, like save and load. */
export type DiscardPostDraftResult = DiscardedPostDraft | PostDraftNotPersisted;

export interface DiscardPostDraftDeps {
  drafts: PostDraftRepo;
  /** Resolves the session e-mail to the `app_user.id` a draft is owned by. */
  users?: UserRepo;
  logger: Logger;
}

export function makeDiscardPostDraft(deps: DiscardPostDraftDeps) {
  return async function discardPostDraft(
    input: DiscardPostDraftInput,
  ): Promise<DiscardPostDraftResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const { address, failure, log } = await resolveDraftAddress(deps, input, "discard");

    if (!address) {
      // "Unknown owner" is not "no owner": a failed lookup leaves the row
      // unaccounted for, so it stays an error the route maps to 5xx, never 204.
      if (failure?.reason === POST_DRAFT_OWNER_LOOKUP_FAILED) {
        log.error("Draft discard refused: the owner could not be resolved", {
          ...failure.error.toLogObject(),
          discarded: false,
        });
        throw failure.error;
      }

      // No owner: no row is addressed to anyone, so "already gone" is exactly
      // the outcome the caller asked for. Deleting by tenant alone would wipe
      // someone else's draft, which is why this branch does nothing at all.
      return POST_DRAFT_NOT_PERSISTED;
    }

    // --- Happy path ----------------------------------------------------------
    // A driver failure stays AppError('DB_ERROR'): a draft that survives a
    // "discard" would come back on the next mount, so it must not be hidden.
    await deps.drafts.discard(address.tenantId, address.ownerUserId, address.kind);
    log.info("Draft discarded");

    return { persisted: true, ownerUserId: address.ownerUserId };
  };
}

export type DiscardPostDraft = ReturnType<typeof makeDiscardPostDraft>;
