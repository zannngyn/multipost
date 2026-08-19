import { and, eq, like, or, sql } from "drizzle-orm";

import {
  isAccountStatus,
  isMembershipStatus,
  isPlatformRole,
  type MembershipStatus,
} from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { isTenantId, isTenantStatus, type TenantStatus } from "@/core/domain/tenant";
import type {
  AccountRepo,
  AttachProviderAccountIdInput,
  MembershipWithTenant,
  OperatorAccountSummary,
} from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import {
  isOperatorProvider,
  isOperatorRole,
  PLACEHOLDER_PROVIDER_ACCOUNT_ID_PREFIXES,
  type OperatorRole,
} from "@/shared/operator-access";

import type { Database } from "./client";
import { findPgError, wrapDbError } from "./db-errors";
import { accounts, identities, memberships, tenants } from "./schema";

/**
 * `account`/`identity`/`membership` reads + the ONE identity write of M1.2
 * (docs/09 §3.1/3.3).
 *
 * NOT tenant-scoped by design: `identity` and `account` sit ABOVE the tenant
 * boundary (the session lookup happens before any tenant is known), so
 * `forTenant()` cannot apply. Membership reads ARE tenant-discriminated, but by
 * the (accountId, tenantId) pair the AUTHORISER supplies — this repo is the
 * source `requireTenant` builds its decision from, not a consumer of one.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A row that fails its enum is corruption — refuse loudly, never coerce. */
function unreadable(field: string, value: unknown): AppError {
  return new AppError("INTERNAL", {
    message: `${field} holds an unknown value`,
    context: { field, value: String(value), reason: "UNREADABLE_ACCOUNT_ROW" },
  });
}

function readRole(value: unknown): OperatorRole {
  if (isOperatorRole(value)) return value;
  throw unreadable("membership.role", value);
}

function readMembershipStatus(value: unknown): MembershipStatus {
  if (isMembershipStatus(value)) return value;
  throw unreadable("membership.status", value);
}

function readTenantStatus(value: unknown): TenantStatus {
  if (isTenantStatus(value)) return value;
  throw unreadable("tenant.status", value);
}

export class DrizzleAccountRepo implements AccountRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async findAccountBySessionEmail(sessionEmail: string): Promise<OperatorAccountSummary | null> {
    const email = str(sessionEmail).toLowerCase();
    // Guard: an empty address must not run a query matching "whoever has ''".
    if (email.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findAccountBySessionEmail requires an address",
        context: { field: "sessionEmail" },
      });
    }

    try {
      const rows = await this.db
        .select({
          accountId: accounts.id,
          accountStatus: accounts.status,
          platformRole: accounts.platformRole,
          displayName: accounts.displayName,
          provider: identities.provider,
          providerAccountId: identities.providerAccountId,
          sessionEmail: identities.sessionEmail,
          email: identities.email,
        })
        .from(identities)
        .innerJoin(accounts, eq(accounts.id, identities.accountId))
        .where(eq(sql`lower(${identities.sessionEmail})`, email))
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      if (!isAccountStatus(row.accountStatus)) throw unreadable("account.status", row.accountStatus);
      if (!isOperatorProvider(row.provider)) throw unreadable("identity.provider", row.provider);

      const membershipRows = await this.db
        .select({
          tenantId: memberships.tenantId,
          role: memberships.role,
          version: memberships.version,
        })
        .from(memberships)
        .where(and(eq(memberships.accountId, row.accountId), eq(memberships.status, "active")));

      return {
        accountId: row.accountId,
        status: row.accountStatus,
        platformRole: isPlatformRole(row.platformRole) ? row.platformRole : null,
        displayName: row.displayName ?? null,
        identity: {
          provider: row.provider,
          providerAccountId: row.providerAccountId,
          sessionEmail: row.sessionEmail,
          email: row.email ?? null,
        },
        activeMemberships: membershipRows.map((membership) => ({
          tenantId: membership.tenantId,
          role: readRole(membership.role),
          version: membership.version,
        })),
      };
    } catch (error) {
      throw wrapDbError(error, {
        operation: "account.findAccountBySessionEmail",
        field: "sessionEmail",
      });
    }
  }

  async attachProviderAccountId(input: AttachProviderAccountIdInput): Promise<boolean> {
    // --- Edge cases first ---------------------------------------------------
    if (!isOperatorProvider(input?.provider)) {
      throw new AppError("INVALID_INPUT", {
        message: "attachProviderAccountId requires a known provider",
        context: { field: "provider" },
      });
    }
    const email = str(input?.sessionEmail).toLowerCase();
    const providerAccountId = str(input?.providerAccountId);
    if (email.length === 0 || providerAccountId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "attachProviderAccountId requires sessionEmail and providerAccountId",
        context: { provider: input.provider },
      });
    }

    try {
      /**
       * UPDATE in place, keyed by (provider, session_email) — the M1.1
       * obligation. An INSERT keyed on (provider, sub) here would collide with
       * `identity_session_email_uq`: the address already has a row, it just
       * carries the backfill's `legacy-app-user:*` placeholder.
       *
       * The WHERE also demands a PLACEHOLDER-shaped current value — the SQL
       * half of the same-provider guard in resolve-operator-account. A row
       * holding a REAL sub simply does not match (0 rows, `false`), so even a
       * caller that skipped the usecase cannot overwrite a stable identity
       * through this method (docs/09 §3.1 — the recycled-e-mail takeover).
       */
      const rows = await this.db
        .update(identities)
        .set({ providerAccountId })
        .where(
          and(
            eq(identities.provider, input.provider),
            eq(sql`lower(${identities.sessionEmail})`, email),
            // Built from the SAME prefix list as isPlaceholderProviderAccountId,
            // so the SQL mirror cannot drift from the shared rule.
            or(
              ...PLACEHOLDER_PROVIDER_ACCOUNT_ID_PREFIXES.map((prefix) =>
                like(identities.providerAccountId, `${prefix}%`),
              ),
            ),
          ),
        )
        .returning({ id: identities.id });

      const patched = rows.length > 0;
      if (patched) {
        this.deps.logger.info("Identity provider account id updated", {
          provider: input.provider,
          identity_id: rows[0].id,
        });
      }
      return patched;
    } catch (error) {
      /**
       * Unique violation on (provider, provider_account_id): the REAL sub
       * already belongs to another identity row. That is a refusal ("this row
       * cannot be claimed"), not a database outage — a 503 at sign-in would
       * tell the operator to retry something retrying can never fix.
       */
      if (findPgError(error)?.code === "23505") {
        this.deps.logger.error("Real sub already belongs to another identity — patch refused", {
          error_code: "UNAUTHORIZED",
          provider: input.provider,
          alert: "OPERATOR_ATTENTION",
        });
        return false;
      }
      throw wrapDbError(error, {
        operation: "account.attachProviderAccountId",
        provider: input.provider,
        field: "providerAccountId",
      });
    }
  }

  async findMembership(accountId: string, tenantId: string): Promise<MembershipWithTenant | null> {
    const account = str(accountId);
    const tenant = str(tenantId);
    // Both come from the authoriser, but a malformed uuid must still read as
    // INVALID_INPUT, not as a 503 from a failed Postgres cast.
    if (account.length === 0 || !isTenantId(tenant)) {
      throw new AppError("INVALID_INPUT", {
        message: "findMembership requires an account id and a UUID tenant id",
        context: { tenant_id: tenant || null, field: "tenantId" },
      });
    }

    try {
      const rows = await this.membershipWithTenantQuery()
        .where(and(eq(memberships.accountId, account), eq(memberships.tenantId, tenant)))
        .limit(1);
      const row = rows[0];
      return row ? this.toMembershipWithTenant(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "account.findMembership",
        tenant_id: tenant,
        field: "accountId",
      });
    }
  }

  async findMembershipVersion(accountId: string, tenantId: string): Promise<number | null> {
    const account = str(accountId);
    const tenant = str(tenantId);
    if (account.length === 0 || !isTenantId(tenant)) {
      throw new AppError("INVALID_INPUT", {
        message: "findMembershipVersion requires an account id and a UUID tenant id",
        context: { tenant_id: tenant || null, field: "tenantId" },
      });
    }

    try {
      const rows = await this.db
        .select({ version: memberships.version })
        .from(memberships)
        .where(and(eq(memberships.accountId, account), eq(memberships.tenantId, tenant)))
        .limit(1);
      return rows[0]?.version ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "account.findMembershipVersion",
        tenant_id: tenant,
        field: "accountId",
      });
    }
  }

  async listMembershipsWithTenant(accountId: string): Promise<readonly MembershipWithTenant[]> {
    const account = str(accountId);
    if (account.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "listMembershipsWithTenant requires an account id",
        context: { field: "accountId" },
      });
    }

    try {
      const rows = await this.membershipWithTenantQuery().where(
        and(eq(memberships.accountId, account), eq(memberships.status, "active")),
      );
      return rows.map((row) => this.toMembershipWithTenant(row));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "account.listMembershipsWithTenant",
        field: "accountId",
      });
    }
  }

  private membershipWithTenantQuery() {
    return this.db
      .select({
        tenantId: memberships.tenantId,
        role: memberships.role,
        status: memberships.status,
        version: memberships.version,
        tenantStatus: tenants.status,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        tenantPlan: tenants.plan,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId));
  }

  private toMembershipWithTenant(row: {
    tenantId: string;
    role: unknown;
    status: unknown;
    version: number;
    tenantStatus: unknown;
    tenantName: string;
    tenantSlug: string | null;
    tenantPlan: string;
  }): MembershipWithTenant {
    return {
      tenantId: row.tenantId,
      role: readRole(row.role),
      status: readMembershipStatus(row.status),
      version: row.version,
      tenantStatus: readTenantStatus(row.tenantStatus),
      tenantName: row.tenantName,
      tenantSlug: row.tenantSlug ?? null,
      tenantPlan: row.tenantPlan,
    };
  }
}
