import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * "Ai đã bấm nút này?" — one answer, shared by every operator action that writes
 * an audit row (retry, reschedule, cancel).
 *
 * An explicit id wins (a caller that already knows it); otherwise the session
 * e-mail is looked up in `app_user`. Every failure to resolve is a WARNING and
 * returns null, never an error: refusing to cancel a post because we could not
 * name the operator would trade a real problem for a bookkeeping one.
 */

export interface ActorInput {
  readonly actorUserId?: string | null;
  readonly actorEmail?: string | null;
}

export interface ResolveActorDeps {
  /** Absent = not wired yet; the action proceeds unattributed, with a warning. */
  users?: UserRepo;
}

export async function resolveActorUserId(
  deps: ResolveActorDeps,
  tenantId: TenantId,
  input: ActorInput,
  log: Logger,
): Promise<string | null> {
  const explicitId = str(input?.actorUserId);
  if (explicitId.length > 0) return explicitId;

  const email = str(input?.actorEmail).toLowerCase();
  if (email.length === 0) return null;

  if (!deps.users) {
    log.warn("Cannot attribute this action: no user repository is wired", {
      reason: "ACTOR_RESOLVER_NOT_WIRED",
      actor_email: email,
    });
    return null;
  }

  try {
    const userId = await deps.users.findUserIdByEmail(tenantId, email);
    if (!userId) {
      // A real case: an allowed domain signs in before the account row exists.
      log.warn("Actor not found in app_user — the audit row will have no actor", {
        reason: "ACTOR_NOT_FOUND",
        actor_email: email,
      });
      return null;
    }
    return userId;
  } catch (error) {
    // Logged with context and swallowed ON PURPOSE: the action itself is
    // unaffected, and the warning says the audit row will be anonymous.
    log.warn("Could not resolve the actor — continuing without attribution", {
      err: AppError.from(error, "DB_ERROR", { tenant_id: tenantId, actor_email: email }),
      reason: "ACTOR_LOOKUP_FAILED",
      actor_email: email,
    });
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
