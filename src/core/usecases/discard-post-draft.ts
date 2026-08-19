import { assertPostDraftAddress } from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";

/**
 * E10 — drops the compose draft: after a batch is created (the draft became a
 * real post) and when the operator presses "Xoá nháp".
 *
 * Idempotent by contract: deleting a draft that is not there is success, not an
 * error. The caller is often a cleanup path running after a redirect, and a
 * throw there would surface as a scary message about work that already
 * completed.
 */

export interface DiscardPostDraftInput {
  readonly tenantId: string;
  readonly ownerUserId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
}

export interface DiscardPostDraftDeps {
  drafts: PostDraftRepo;
  logger: Logger;
}

export function makeDiscardPostDraft(deps: DiscardPostDraftDeps) {
  return async function discardPostDraft(input: DiscardPostDraftInput): Promise<void> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const address = assertPostDraftAddress(input);
    const log = deps.logger.child({
      tenant_id: address.tenantId,
      owner_user_id: address.ownerUserId,
      draft_kind: address.kind,
    });

    // --- Happy path ----------------------------------------------------------
    // A driver failure stays AppError('DB_ERROR'): a draft that survives a
    // "discard" would come back on the next mount, so it must not be hidden.
    await deps.drafts.discard(address.tenantId, address.ownerUserId, address.kind);
    log.info("Draft discarded");
  };
}

export type DiscardPostDraft = ReturnType<typeof makeDiscardPostDraft>;
