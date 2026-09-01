import { AppError } from "@/core/domain/errors";
import type { AccountRepo, MembershipWithTenant } from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import type { CreateTenant } from "@/core/usecases/create-tenant";

/**
 * E10 — a signed-in account always has somewhere to work.
 *
 * Buffer creates the organisation at sign-up; MYSP provisions it LAZILY, the
 * first time an account reaches the app without belonging to one. What the
 * operator sees is the same (the "tạo công ty" screen never appears), but the
 * auth layer is untouched and every abuse limit still applies. Someone who
 * registers and never opens the app simply owns no company — that costs
 * nobody anything.
 *
 * This is NOT a second way to create a tenant: it delegates to `createTenant`,
 * which owns the name/slug rules and hands the repo the abuse caps counted
 * inside its transaction.
 *
 * Two invariants, in order of how badly they break things:
 *
 * 1. NEVER a second company. An account with any membership gets that
 *    membership back — including a membership in a SUSPENDED tenant, because
 *    minting a fresh one there would make a platform suspension undoable by
 *    reloading the page.
 * 2. Two tabs must not produce two companies. The usecase does not defend that
 *    with its own read-then-write (two callers would both read "none"): the
 *    repo's transaction serialises the creates, and the loser comes back with
 *    a typed refusal. Only then do we re-read — if the winner's membership is
 *    there, we adopt it; if it is not, the refusal was real and travels on
 *    with its code intact.
 */

/**
 * Deliberately generic, exactly like Buffer's "My organization". Nothing from
 * the person is stitched in: `displayName` may be null and the /api/me payload
 * carries no e-mail, so a stitched name would read as either a bug or a
 * stranger's address. It is renamed in Cài đặt, in one field.
 */
export const DEFAULT_TENANT_NAME = "Công ty của tôi";

export interface EnsureDefaultTenantInput {
  readonly accountId: string;
  readonly sessionEmail: string;
  readonly displayName?: string | null;
}

export interface EnsureDefaultTenantResult {
  readonly tenantId: string;
  /** False when the account already belonged somewhere — the common case. */
  readonly wasCreated: boolean;
}

export interface EnsureDefaultTenantDeps {
  /** Fresh membership read — a cached one could re-provision after a revoke. */
  accounts: Pick<AccountRepo, "listMembershipsWithTenant">;
  createTenant: CreateTenant;
  logger: Logger;
}

export type EnsureDefaultTenant = (
  input: EnsureDefaultTenantInput,
) => Promise<EnsureDefaultTenantResult>;

export function makeEnsureDefaultTenant(deps: EnsureDefaultTenantDeps): EnsureDefaultTenant {
  return async function ensureDefaultTenant(input) {
    // --- Edge cases first ---------------------------------------------------
    const accountId = str(input?.accountId);
    const sessionEmail = str(input?.sessionEmail).toLowerCase();
    if (accountId.length === 0 || sessionEmail.length === 0) {
      throw new AppError("UNAUTHORIZED", {
        message: "ensureDefaultTenant requires a session backed by an account",
        context: { has_account_id: accountId.length > 0 },
      });
    }

    const log = deps.logger.child({ account_id: accountId });

    const existing = pickHome(await deps.accounts.listMembershipsWithTenant(accountId));
    if (existing) {
      if (existing.tenantStatus !== "active") {
        // Nothing to do, but the operator is about to hit a wall inside the
        // app: say so here rather than let support guess.
        log.warn("Account's only company is not active — no company provisioned", {
          tenant_id: existing.tenantId,
          tenant_status: existing.tenantStatus,
        });
      } else {
        log.debug("Account already belongs to a company", { tenant_id: existing.tenantId });
      }
      return { tenantId: existing.tenantId, wasCreated: false };
    }

    try {
      const created = await deps.createTenant({
        accountId,
        sessionEmail,
        displayName: input?.displayName ?? null,
        name: DEFAULT_TENANT_NAME,
        // No slug on purpose: a slug WE choose is a hard SLUG_TAKEN on
        // collision, while a DERIVED one retries with a random suffix inside
        // createTenant — and every default company derives the same slug.
        slug: null,
      });
      log.info("Default company provisioned on first entry", {
        tenant_id: created.tenant.id,
        slug: created.tenant.slug,
      });
      return { tenantId: created.activeTenantId, wasCreated: true };
    } catch (error) {
      const errorCode = AppError.is(error) ? error.code : "UNKNOWN";
      log.error("Default company provisioning failed", {
        error_code: errorCode,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // The racing tab may have committed while we were being refused.
      const raced = pickHome(await deps.accounts.listMembershipsWithTenant(accountId));
      if (raced) {
        log.info("Adopted the company a concurrent request created", {
          tenant_id: raced.tenantId,
          error_code: errorCode,
        });
        return { tenantId: raced.tenantId, wasCreated: false };
      }

      // No company: the refusal was real (abuse cap, slug exhaustion, driver
      // failure). It travels on with its code so the UI can name it.
      throw error;
    }
  };
}

/**
 * Which company this account calls home. An active tenant wins over a
 * suspended one; ties are broken by the repo's own order so two calls agree.
 */
function pickHome(
  memberships: readonly MembershipWithTenant[],
): MembershipWithTenant | null {
  if (memberships.length === 0) return null;
  return memberships.find((membership) => membership.tenantStatus === "active") ?? memberships[0];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
