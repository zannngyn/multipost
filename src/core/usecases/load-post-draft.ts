import {
  parseComposeDraftPayload,
  POST_DRAFT_NOT_PERSISTED,
  POST_DRAFT_SCHEMA_VERSION,
  type ComposeDraftPayload,
  type PostDraftNotPersisted,
  type PostDraftOwnerInput,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { PostDraftRepo } from "@/core/ports/post-draft-repo";
import type { UserRepo } from "@/core/ports/user-repo";

import { resolveDraftAddress } from "./resolve-draft-owner";

/**
 * E10 — reads back the compose draft when the screen mounts.
 *
 * Deliberately forgiving, and only in ONE direction: a draft that cannot be
 * used (written by an older schema version, or no longer matching the shape)
 * answers `draft: null` + a warn log instead of throwing. An unusable draft must
 * not lock an operator out of the compose screen — the worst outcome is
 * retyping, the best is a screen that never opens. The warn keeps it visible.
 *
 * Two "nothing to show" cases stay TOLD APART on purpose: `persisted: false`
 * means this operator has no server-side storage at all (no `app_user` row), and
 * `{ persisted: true, draft: null }` means they have storage and it is empty.
 * The screen reacts differently to each.
 *
 * What it does NOT do: rebuild the post. The returned payload is input only;
 * the caller re-runs compose (Sheet lookup + stock gate) exactly as if the
 * fields had just been typed (business rule 1 and 3).
 */

export interface LoadPostDraftInput extends PostDraftOwnerInput {
  readonly tenantId: string;
  /** Defaults to 'compose'. */
  readonly kind?: string;
}

export interface LoadedPostDraft {
  readonly payload: ComposeDraftPayload;
  readonly schemaVersion: number;
  /** ISO-8601. */
  readonly updatedAt: string;
}

export interface LoadedPostDraftResult {
  readonly persisted: true;
  /** `app_user.id` the draft is addressed by — the caller scopes its local buffer with it. */
  readonly ownerUserId: string;
  /** Null when this operator simply has no (usable) stored draft. */
  readonly draft: LoadedPostDraft | null;
}

/** Discriminated on `persisted`, like save and discard. */
export type LoadPostDraftResult = LoadedPostDraftResult | PostDraftNotPersisted;

export interface LoadPostDraftDeps {
  drafts: PostDraftRepo;
  /** Resolves the session e-mail to the `app_user.id` a draft is owned by. */
  users?: UserRepo;
  logger: Logger;
}

export function makeLoadPostDraft(deps: LoadPostDraftDeps) {
  return async function loadPostDraft(input: LoadPostDraftInput): Promise<LoadPostDraftResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) -----------------------
    const { address, log } = await resolveDraftAddress(deps, input, "load");

    // No owner: there is no row to read, and reading someone else's would be
    // worse than reading none. Not an error — the browser buffer takes over.
    // A FAILED lookup lands here too, deliberately: the worst outcome of not
    // opening a server draft is retyping, while throwing would block the compose
    // screen entirely. `resolveDraftAddress` logs which of the two happened.
    if (!address) return POST_DRAFT_NOT_PERSISTED;

    const empty: LoadedPostDraftResult = {
      persisted: true,
      ownerUserId: address.ownerUserId,
      draft: null,
    };

    // A repo failure is an AppError('DB_ERROR') and stays one: "the DB is down"
    // and "there is no draft" must not look the same to the caller.
    const stored = await deps.drafts.load(address.tenantId, address.ownerUserId, address.kind);
    if (!stored) {
      log.debug("No stored draft for this operator");
      return empty;
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
      return empty;
    }

    const parsed = parseComposeDraftPayload(stored.payload);
    if (!parsed.ok) {
      log.warn("Stored draft ignored: payload no longer matches the draft shape", {
        ...parsed.error.toLogObject(),
        updated_at: stored.updatedAt.toISOString(),
      });
      return empty;
    }

    // --- Happy path ----------------------------------------------------------
    log.debug("Draft loaded", {
      schema_version: stored.schemaVersion,
      draft_step: parsed.payload.step,
      updated_at: stored.updatedAt.toISOString(),
    });

    return {
      persisted: true,
      ownerUserId: address.ownerUserId,
      draft: {
        payload: parsed.payload,
        schemaVersion: stored.schemaVersion,
        updatedAt: stored.updatedAt.toISOString(),
      },
    };
  };
}

export type LoadPostDraft = ReturnType<typeof makeLoadPostDraft>;
