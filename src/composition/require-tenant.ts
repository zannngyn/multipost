import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { TenantContext, TenantId } from "@/core/domain/tenant-context";
import type { AccountRepo, MembershipWithTenant } from "@/core/ports/account-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * `requireTenant()` — defence layer #1 of B-8 (docs/09 §3.3, doc 10 §2–3).
 * The ONLY place a request's tenant is decided, and (with the blessed makers
 * listed in core/domain/tenant-context.ts) the only production constructor of
 * the branded `TenantId`.
 *
 * The cookie is a SELECTOR, never authorisation: it picks WHICH membership to
 * check, and the membership row in the database is what authorises. M1.2 builds
 * the mechanism; M1.3 wires it into the 46 route edges.
 *
 * Error semantics (doc 10 §3), refusals first:
 *   - no session/account            → 401 UNAUTHORIZED
 *   - no cookie, 0 or 2+ companies  → 409 TENANT_NOT_SELECTED (UI: picker)
 *   - cookie → no active membership → 404 TENANT_NOT_FOUND (never reveals
 *     whether the tenant exists), same for a suspended tenant
 *   - member but role below minRole → 403 FORBIDDEN
 */

/** Cache tiers (docs/09 §3.4). The tier is the CALLER's claim about the route. */
export type AuthzTier = "S" | "M" | "R";

/**
 * Re-exported for the app layer: routes receive a TenantContext from
 * requireTenantContext() but may not import core/domain/tenant-context
 * directly (ESLint one-way rule — app sees core types only through
 * composition).
 */
export type { TenantContext, TenantId } from "@/core/domain/tenant-context";

export const TENANT_CONTEXT_CACHE_TTL_MS = 60_000;

export interface RequireTenantSession {
  /** Null for dev-fake / env-bootstrap sessions without an account row. */
  readonly accountId: string | null;
  /** For log lines only — never used to authorise. */
  readonly email: string;
}

export interface RequireTenantOptions {
  readonly tier: AuthzTier;
  /** When set, the membership's role must be >= this (doc 10 §1 ladder). */
  readonly minRole?: OperatorRole;
}

export type RequireTenant = (
  session: RequireTenantSession | null,
  cookieTenantId: string | null | undefined,
  options: RequireTenantOptions,
) => Promise<TenantContext>;

export interface RequireTenantGate {
  requireTenant: RequireTenant;
  /** Drops every cached membership. Called the moment a decision is written. */
  invalidateAll(): void;
}

export interface RequireTenantDeps {
  accounts: AccountRepo;
  clock: Clock;
  logger: Logger;
  /** Injection seam for tests. Defaults to TENANT_CONTEXT_CACHE_TTL_MS. */
  ttlMs?: number;
}

interface CacheEntry {
  readonly membership: MembershipWithTenant;
  readonly expiresAt: number;
}

export function makeRequireTenant(deps: RequireTenantDeps): RequireTenantGate {
  const ttlMs =
    typeof deps.ttlMs === "number" && deps.ttlMs > 0 ? deps.ttlMs : TENANT_CONTEXT_CACHE_TTL_MS;
  /** Key `(accountId, tenantId)`; only ACTIVE memberships of ACTIVE tenants. */
  const cache = new Map<string, CacheEntry>();

  async function readMembership(
    accountId: string,
    tenantId: TenantId,
    tier: AuthzTier,
  ): Promise<MembershipWithTenant | null> {
    // Tier S: credentials/publishing/membership ops — always the fresh row.
    if (tier === "S") return deps.accounts.findMembership(accountId, tenantId);

    const key = `${accountId}:${tenantId}`;
    const now = deps.clock.nowMs();
    const cached = cache.get(key);

    if (cached && cached.expiresAt > now) {
      if (tier === "R") return cached.membership;
      /**
       * Tier M: the cached row is only trusted while its `version` still
       * matches the database — the cross-process half of revocation. A bumped
       * version (role change, removal) forces a fresh read even mid-TTL.
       */
      const freshVersion = await deps.accounts.findMembershipVersion(accountId, tenantId);
      if (freshVersion === cached.membership.version) return cached.membership;
      cache.delete(key);
    }

    const membership = await deps.accounts.findMembership(accountId, tenantId);
    // Only a usable membership is cached: a denial must be re-checked next time
    // (an admin may approve in between), and caching it would delay the grant.
    if (membership && membership.status === "active" && membership.tenantStatus === "active") {
      cache.set(key, { membership, expiresAt: now + ttlMs });
    }
    return membership;
  }

  const requireTenant: RequireTenant = async (session, cookieTenantId, options) => {
    // --- Refusals first (doc 10 §3) -----------------------------------------
    if (!session || typeof session.accountId !== "string" || session.accountId.length === 0) {
      // Covers both "no session" and a session with no account row (bootstrap
      // without membership): neither can hold a membership, and platform-admin
      // access is a DIFFERENT door (M3.3), not this one.
      throw new AppError("UNAUTHORIZED", {
        message: "requireTenant needs a session backed by an account",
        context: { reason: session ? "NO_ACCOUNT" : "NO_SESSION" },
      });
    }
    const tier = options?.tier;
    if (tier !== "S" && tier !== "M" && tier !== "R") {
      // A route that cannot name its tier has not read the contract — refuse
      // loudly instead of silently defaulting to the weakest check.
      throw new AppError("INTERNAL", {
        message: "requireTenant called without a valid authorization tier",
        context: { tier: String(tier) },
      });
    }

    const accountId = session.accountId;
    const log = deps.logger.child({ account_id: accountId });

    /**
     * Garbage in the cookie (edited, truncated, stale format) reads as ABSENT,
     * not as an error: the selector failed, so fall through to the same "which
     * company?" logic. Logged, because a burst of malformed cookies is a probe.
     */
    const rawSelected = typeof cookieTenantId === "string" ? cookieTenantId.trim() : "";
    // `as unknown` sidesteps the guard's narrowing (a negated `value is string`
    // guard collapses a string to `never`); the check itself is unchanged.
    const cookieIsUsable = isTenantId(rawSelected as unknown);
    if (rawSelected.length > 0 && !cookieIsUsable) {
      log.warn("Active-tenant cookie is malformed — treating as unselected", {
        error_code: "INVALID_INPUT",
        cookie_length: rawSelected.length,
      });
    }
    // Blessed cast site (see core/domain/tenant-context.ts): rawSelected passed
    // isTenantId above, and only a membership-checked value leaves this function.
    const selected: TenantId | "" = cookieIsUsable ? (rawSelected as TenantId) : "";

    if (selected === "") {
      const activeMemberships = await deps.accounts.listMembershipsWithTenant(accountId);
      const usable = activeMemberships.filter((m) => m.tenantStatus === "active");
      if (usable.length === 1) {
        // One company needs no cookie — auto-active (docs/09 §3.8).
        return toContext(usable[0], options.minRole, log);
      }
      // Zero (NoMembership) and several (chưa chọn) are the SAME answer to the
      // caller: pick one first. The UI knows which screen from /api/me.
      throw new AppError("TENANT_NOT_SELECTED", {
        message:
          usable.length === 0
            ? "Account has no active membership in any tenant"
            : "Account belongs to several tenants and none is selected",
        context: { account_id: accountId, membership_count: usable.length },
      });
    }

    const membership = await readMembership(accountId, selected, tier);
    if (!membership || membership.status !== "active" || membership.tenantStatus !== "active") {
      // No membership, removed membership, suspended tenant, nonexistent
      // tenant: ONE indistinguishable 404, so this cannot probe what exists.
      log.warn("Tenant resolution refused", {
        tenant_id: selected,
        error_code: "TENANT_NOT_FOUND",
        membership_found: membership !== null,
        tier,
      });
      throw new AppError("TENANT_NOT_FOUND", {
        message: "Account has no active membership in the selected tenant",
        userMessage: "Không tìm thấy công ty tương ứng.",
        context: { tenant_id: selected },
      });
    }

    return toContext(membership, options.minRole, log);
  };

  function toContext(
    membership: MembershipWithTenant,
    minRole: OperatorRole | undefined,
    log: Logger,
  ): TenantContext {
    if (minRole && !roleAtLeast(membership.role, minRole)) {
      log.warn("Role below the required minimum for this route", {
        tenant_id: membership.tenantId,
        error_code: "FORBIDDEN",
        membership_role: membership.role,
        required_role: minRole,
      });
      throw new AppError("FORBIDDEN", {
        message: `Route requires at least '${minRole}', membership holds '${membership.role}'`,
        context: { tenant_id: membership.tenantId, required_role: minRole },
      });
    }
    return {
      // Blessed cast site (see core/domain/tenant-context.ts): this string was
      // just authorised against the membership table, which is what the brand
      // certifies.
      tenantId: membership.tenantId as TenantId,
      role: membership.role,
      membershipVersion: membership.version,
    };
  }

  return {
    requireTenant,
    invalidateAll() {
      cache.clear();
    },
  };
}
