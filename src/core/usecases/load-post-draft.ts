import {
  assertPostDraftAddress,
  parseComposeDraftPayload,
  POST_DRAFT_SCHEMA_VERSION,
  type ComposeDraftPayload,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";

/**
 * E10 — reads back the compose draft when the screen mounts.
 *
 * Deliberately forgiving, and only in ONE direction: a draft that cannot be
 * used (written by an older schema version, or no longer matching the shape)
 * answers `null` + a warn log instead of throwing. An unusable draft must not
 * lock an operator out of the compose screen — the worst outcome is retyping,
 * the best is a screen that never opens. The warn keeps it visible.
 *
 * What it does NOT do: rebuild the post. The returned payload is input only;
 * the caller re-runs compose (Sheet lookup + stock gate) exactly as if the
 * fields had just been typed (business rule 1 and 3).
 */

export interface LoadPostDraftInput {
  readonly tenantId: string;
  readonly ownerUserId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
}

export interface LoadPostDraftResult {
  readonly payload: ComposeDraftPayload;
  readonly schemaVersion: number;
  /** ISO-8601. */
  readonly updatedAt: string;
}

export interface LoadPostDraftDeps {
  drafts: PostDraftRepo;
  logger: Logger;
}

export function makeLoadPostDraft(deps: LoadPostDraftDeps) {
  return async function loadPostDraft(
    input: LoadPostDraftInput,
  ): Promise<LoadPostDraftResult | null> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const address = assertPostDraftAddress(input);
    const log = deps.logger.child({
      tenant_id: address.tenantId,
      owner_user_id: address.ownerUserId,
      draft_kind: address.kind,
    });

    // A repo failure is an AppError('DB_ERROR') and stays one: "the DB is down"
    // and "there is no draft" must not look the same to the caller.
    const stored = await deps.drafts.load(address.tenantId, address.ownerUserId, address.kind);
    if (!stored) {
      log.debug("No stored draft for this operator");
      return null;
    }

    if (stored.schemaVersion !== POST_DRAFT_SCHEMA_VERSION) {
      // No migration path exists yet; when one does, it belongs right here.
      log.warn("Stored draft ignored: schema version does not match", {
        error_code: "DRAFT_PAYLOAD_REJECTED",
        reason: "SCHEMA_VERSION_MISMATCH",
        stored_schema_version: stored.schemaVersion,
        expected_schema_version: POST_DRAFT_SCHEMA_VERSION,
        updated_at: stored.updatedAt.toISOString(),
      });
      return null;
    }

    const parsed = parseComposeDraftPayload(stored.payload);
    if (!parsed.ok) {
      log.warn("Stored draft ignored: payload no longer matches the draft shape", {
        ...parsed.error.toLogObject(),
        updated_at: stored.updatedAt.toISOString(),
      });
      return null;
    }

    // --- Happy path ----------------------------------------------------------
    log.debug("Draft loaded", {
      schema_version: stored.schemaVersion,
      draft_step: parsed.payload.step,
      updated_at: stored.updatedAt.toISOString(),
    });

    return {
      payload: parsed.payload,
      schemaVersion: stored.schemaVersion,
      updatedAt: stored.updatedAt.toISOString(),
    };
  };
}

export type LoadPostDraft = ReturnType<typeof makeLoadPostDraft>;
