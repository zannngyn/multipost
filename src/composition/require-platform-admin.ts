import { AppError } from "@/core/domain/errors";
import type { AccountRepo } from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import type { PlatformRole } from "@/shared/operator-access";

/**
 * `requirePlatformAdmin()` — the platform twin of `requireTenant` (M3.1,
 * docs/09 §3.5). No tenant context at all: it answers "may this PERSON operate
 * the platform", and the answer comes from `account.platform_role` read FRESH
 * on every call — every platform op is tier S, and a revoked/suspended admin
 * must die on the next request, not a TTL later.
 *
 * The DB is the source of truth (N9 closed): a bootstrap admin whose account
 * row is suspended is refused here like anyone else — the env promoted them
 * ONCE (see session.ts), it does not resurrect them.
 *
 * Ladder (doc 10 §1): support < super_admin.
 */

export interface PlatformSession {
  readonly accountId: string | null;
  /** For log lines only — never used to authorise. */
  readonly email: string;
}

export interface PlatformContext {
  readonly accountId: string;
  readonly platformRole: PlatformRole;
}

export type RequirePlatformAdmin = (
  session: PlatformSession | null,
  options: { readonly minRole: PlatformRole },
) => Promise<PlatformContext>;

const PLATFORM_RANK: Record<PlatformRole, number> = { support: 0, super_admin: 1 };

export function makeRequirePlatformAdmin(deps: {
  accounts: AccountRepo;
  logger: Logger;
}): RequirePlatformAdmin {
  return async function requirePlatformAdmin(session, options) {
    // --- Refusals first -----------------------------------------------------
    if (!session || typeof session.accountId !== "string" || session.accountId.length === 0) {
      // No session, or a session with no account row (a rescue-door bootstrap
      // sign-in while the DB was down): the platform never runs on env alone.
      throw new AppError("UNAUTHORIZED", {
        message: "Platform operation requires a session backed by an account",
        context: { reason: session ? "NO_ACCOUNT" : "NO_SESSION" },
      });
    }
    const minRole = options?.minRole;
    if (minRole !== "support" && minRole !== "super_admin") {
      throw new AppError("INTERNAL", {
        message: "requirePlatformAdmin called without a valid minimum role",
        context: { min_role: String(minRole) },
      });
    }

    // FRESH, never cached: tier S by definition.
    const standing = await deps.accounts.findPlatformStanding(session.accountId);

    if (!standing || standing.status !== "active" || standing.platformRole === null) {
      deps.logger.warn("Platform operation refused", {
        error_code: "FORBIDDEN",
        account_id: session.accountId,
        account_found: standing !== null,
        account_status: standing?.status ?? null,
        has_platform_role: standing?.platformRole != null,
      });
      throw new AppError("FORBIDDEN", {
        message: "Account holds no active platform role",
        context: { account_id: session.accountId },
      });
    }

    if (PLATFORM_RANK[standing.platformRole] < PLATFORM_RANK[minRole]) {
      deps.logger.warn("Platform operation refused: role below the required minimum", {
        error_code: "FORBIDDEN",
        account_id: session.accountId,
        platform_role: standing.platformRole,
        required_role: minRole,
      });
      throw new AppError("FORBIDDEN", {
        message: `Platform op requires '${minRole}', account holds '${standing.platformRole}'`,
        context: { account_id: session.accountId, required_role: minRole },
      });
    }

    return { accountId: session.accountId, platformRole: standing.platformRole };
  };
}
