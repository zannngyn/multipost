import { AppError } from "@/core/domain/errors";
import {
  assertPostDraftAddress,
  assertPostDraftScope,
  POST_DRAFT_NO_USER,
  type PostDraftAddress,
  type PostDraftOwnerInput,
  type PostDraftScopeInput,
} from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

/**
 * "Whose draft is this?" — one answer, shared by save / load / discard.
 *
 * The three draft usecases are addressed by (tenant, owner, kind) but their
 * caller only has a SESSION E-MAIL, so the translation belongs here, next to the
 * decision it drives, and not in the route: "no app_user row -> do not touch the
 * server" is a business rule, and a rule repeated in three HTTP handlers is a
 * rule nobody tests.
 *
 * Same shape as `resolve-actor`: an explicit id wins, an owner that cannot be
 * found is a WARNING and not an error. It does NOT reuse `resolveActorUserId`,
 * on purpose — that helper answers null for both "no such user" and "the lookup
 * blew up", which is right for an audit column and wrong here. A draft usecase
 * has to tell them apart:
 *
 *   - NO_USER: the lookup ran and this tenant has no such operator. Nothing is
 *     stored for them, so save/load/discard all end as no-ops (`persisted:false`).
 *   - LOOKUP_FAILED: the lookup itself failed, so we know NOTHING about the
 *     draft. `discard` must not report success for a row that may still be
 *     there; it rethrows the DB_ERROR (business rule 5).
 *
 * The failure is RETURNED rather than decided here because the right reaction
 * differs per operation, and only the usecase knows it.
 */

export type DraftOwnerInput = PostDraftScopeInput & PostDraftOwnerInput;

export interface ResolveDraftOwnerDeps {
  /**
   * Optional for the same reason `resolve-actor` keeps it optional: a container
   * that has not wired it yet degrades to "local-only drafts" with a warning,
   * instead of failing every autosave.
   */
  users?: UserRepo;
  logger: Logger;
}

/** The owner lookup threw — the answer is unknown, not "nobody". */
export const POST_DRAFT_OWNER_LOOKUP_FAILED = "LOOKUP_FAILED";

export type DraftOwnerFailure =
  | { readonly reason: typeof POST_DRAFT_NO_USER }
  | {
      readonly reason: typeof POST_DRAFT_OWNER_LOOKUP_FAILED;
      /** Already logged with context; a usecase that rethrows keeps one cause. */
      readonly error: AppError;
    };

export interface DraftOwnerResolution {
  /** Null = no address to work with; `failure` says why. */
  readonly address: PostDraftAddress | null;
  /** Null if and only if `address` is set. */
  readonly failure: DraftOwnerFailure | null;
  /** Child logger already carrying tenant_id, draft_kind and the owner when known. */
  readonly log: Logger;
}

/**
 * Validates the scope, resolves the owner, and returns the address to work with.
 *
 * Throws (INVALID_INPUT) only on a caller bug — a malformed tenant, kind, or an
 * `ownerUserId` that was given but is not a uuid. An owner that cannot be found
 * comes back as `address: null` plus the reason.
 */
export async function resolveDraftAddress(
  deps: ResolveDraftOwnerDeps,
  input: DraftOwnerInput | null | undefined,
  operation: "save" | "load" | "discard",
): Promise<DraftOwnerResolution> {
  // Scope first: a malformed tenant/kind must never reach a repository.
  const scope = assertPostDraftScope(input);
  const scopeLog = deps.logger.child({
    tenant_id: scope.tenantId,
    draft_kind: scope.kind,
    draft_operation: operation,
  });

  // --- Edge cases first (CLAUDE.md technical rule 1) -------------------------

  // An explicit owner wins and is never looked up. Present-but-unusable (blank,
  // wrong type, not a uuid) stays a LOUD caller bug: a caller that says it knows
  // the owner and does not is a different problem from one that has no session,
  // and degrading it to "chỉ lưu trên máy này" would hide it.
  const explicitOwner = input?.ownerUserId;
  if (explicitOwner !== undefined && explicitOwner !== null) {
    const address = assertPostDraftAddress({ ...scope, ownerUserId: explicitOwner });
    return {
      address,
      failure: null,
      log: scopeLog.child({ owner_user_id: address.ownerUserId }),
    };
  }

  const email = typeof input?.ownerEmail === "string" ? input.ownerEmail.trim().toLowerCase() : "";
  if (email.length === 0) {
    return noUser(scopeLog, { detail: "NO_OWNER_IDENTITY" });
  }

  if (!deps.users) {
    return noUser(scopeLog, { detail: "OWNER_RESOLVER_NOT_WIRED", owner_email: email });
  }

  let ownerUserId: string | null;
  try {
    ownerUserId = await deps.users.findUserIdByEmail(scope.tenantId, email);
  } catch (error) {
    // NOT swallowed: logged here with context and handed back as its own reason
    // so each usecase can decide. `discard` turns it into a 5xx; save/load keep
    // degrading to the browser buffer, which loses nothing.
    const appError = AppError.from(error, "DB_ERROR", {
      tenant_id: scope.tenantId,
      draft_kind: scope.kind,
      draft_operation: operation,
      owner_email: email,
      reason: POST_DRAFT_OWNER_LOOKUP_FAILED,
    });
    scopeLog.warn("Draft owner lookup failed — this draft cannot be addressed", {
      ...appError.toLogObject(),
      reason: POST_DRAFT_OWNER_LOOKUP_FAILED,
      persisted: false,
    });
    return {
      address: null,
      failure: { reason: POST_DRAFT_OWNER_LOOKUP_FAILED, error: appError },
      log: scopeLog,
    };
  }

  if (ownerUserId === null) {
    // A real case: an allowed domain signs in before the account row exists.
    return noUser(scopeLog, { detail: "OWNER_NOT_FOUND", owner_email: email });
  }

  // --- Happy path ------------------------------------------------------------
  // Re-validated as an address: a uuid coming out of a repository has not been
  // checked by anything yet, and an owner that is not a uuid is a bug we refuse
  // loudly rather than store a draft nobody can find again.
  const address = assertPostDraftAddress({ ...scope, ownerUserId });

  return {
    address,
    failure: null,
    log: scopeLog.child({ owner_user_id: address.ownerUserId }),
  };
}

/**
 * The "nobody owns this" answer. Not an error: the operator keeps working, the
 * draft just stays in the browser. Logged so "vì sao nháp không lưu?" has an
 * answer without a debugger.
 */
function noUser(log: Logger, context: Record<string, unknown>): DraftOwnerResolution {
  log.warn("Draft is not server-side: no app_user matches this operator", {
    ...context,
    reason: POST_DRAFT_NO_USER,
    persisted: false,
  });
  return { address: null, failure: { reason: POST_DRAFT_NO_USER }, log };
}
