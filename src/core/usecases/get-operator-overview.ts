import type { PlatformRole } from "@/core/domain/account";
import type { AccountRepo } from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.2 — `GET /api/me`: who am I, which companies do I belong to, which one is
 * active. Valid in EVERY signed-in state (doc 10 §4.4), including NoMembership
 * (`tenants: []`) and a bootstrap/dev session with no account row at all
 * (`account: null`) — the UI needs an answer, not a 404, to draw the picker or
 * the "tạo hoặc tham gia" screen (docs/09 §3.8).
 */

export interface OperatorOverview {
  /** Null for env-bootstrap / dev-bypass sessions that have no account row. */
  readonly account: {
    readonly id: string;
    readonly displayName: string | null;
    readonly platformRole: PlatformRole | null;
  } | null;
  readonly tenants: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string | null;
    readonly plan: string;
    readonly role: OperatorRole;
  }[];
  readonly activeTenantId: string | null;
}

export interface GetOperatorOverviewInput {
  readonly sessionEmail: string;
  /** Raw cookie value; validated against the membership list, never trusted. */
  readonly cookieTenantId?: string | null;
}

export interface GetOperatorOverviewDeps {
  accounts: AccountRepo;
  logger: Logger;
}

export type GetOperatorOverview = (input: GetOperatorOverviewInput) => Promise<OperatorOverview>;

export function makeGetOperatorOverview(deps: GetOperatorOverviewDeps): GetOperatorOverview {
  return async function getOperatorOverview(input) {
    // --- Edge cases first ---------------------------------------------------
    const sessionEmail =
      typeof input?.sessionEmail === "string" ? input.sessionEmail.trim().toLowerCase() : "";
    if (sessionEmail.length === 0) {
      // The route only calls this with a session; an empty address is a bug
      // upstream, but the safe answer is still an empty overview, not a throw.
      return { account: null, tenants: [], activeTenantId: null };
    }

    const summary = await deps.accounts.findAccountBySessionEmail(sessionEmail);
    if (!summary) return { account: null, tenants: [], activeTenantId: null };

    const memberships = await deps.accounts.listMembershipsWithTenant(summary.accountId);
    // A suspended tenant is not offered as a workplace (docs/09 §3.7).
    const tenants = memberships
      .filter((membership) => membership.tenantStatus === "active")
      .map((membership) => ({
        id: membership.tenantId,
        name: membership.tenantName,
        slug: membership.tenantSlug,
        plan: membership.tenantPlan,
        role: membership.role,
      }));

    /**
     * The cookie is a SELECTOR, not authorisation (docs/09 Q5): it counts only
     * when it points at a company in the list. One company needs no cookie —
     * it is auto-active, mirroring what `requireTenant` will decide.
     */
    const cookie = typeof input?.cookieTenantId === "string" ? input.cookieTenantId.trim() : "";
    const activeTenantId =
      cookie.length > 0 && tenants.some((tenant) => tenant.id === cookie)
        ? cookie
        : tenants.length === 1
          ? tenants[0].id
          : null;

    deps.logger.debug("Operator overview read", {
      account_id: summary.accountId,
      tenant_count: tenants.length,
      active_tenant_selected: activeTenantId !== null,
    });

    return {
      account: {
        id: summary.accountId,
        displayName: summary.displayName,
        platformRole: summary.platformRole,
      },
      tenants,
      activeTenantId,
    };
  };
}
