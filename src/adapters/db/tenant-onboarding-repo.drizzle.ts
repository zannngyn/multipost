import { and, count, eq, gte, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  CreatedTenant,
  CreateTenantRecord,
  TenantOnboardingRepo,
} from "@/core/ports/tenant-onboarding";

import type { Database } from "./client";
import { findPgError, wrapDbError } from "./db-errors";
import { auditLogs, accounts, memberships, tenants, users } from "./schema";

/**
 * Self-service tenant creation (M2.1, docs/09 §3.7).
 *
 * ONE transaction creates the whole shape — tenant, owner membership,
 * `app_user` (the M1.1 1:1 invariant) and the audit row: a company that exists
 * without an owner, even for one crashed millisecond, is a row nobody can ever
 * administer.
 *
 * The abuse limits are counted INSIDE the transaction, behind a per-account
 * advisory lock (same pattern as `integration-lock.ts`): without the lock, two
 * concurrent creates both count 2 < 3 and the cap leaks.
 */

const HOUR_MS = 60 * 60 * 1000;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class DrizzleTenantOnboardingRepo implements TenantOnboardingRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async createTenant(input: CreateTenantRecord): Promise<CreatedTenant> {
    // --- Edge cases first ---------------------------------------------------
    const accountId = str(input?.accountId);
    const slug = str(input?.slug).toLowerCase();
    const name = str(input?.name);
    if (accountId.length === 0 || slug.length === 0 || name.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "createTenant requires accountId, name and slug",
        context: { field: accountId ? (name ? "slug" : "name") : "accountId" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // Serialises creates PER ACCOUNT — the counts below are then exact.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`tenant_create:${accountId}`}))`,
        );

        const accountRows = await tx
          .select({ platformRole: accounts.platformRole })
          .from(accounts)
          .where(eq(accounts.id, accountId));
        const isSuperAdmin = accountRows[0]?.platformRole === "super_admin";

        if (!isSuperAdmin) {
          const [{ total }] = await tx
            .select({ total: count() })
            .from(tenants)
            .where(eq(tenants.createdByAccountId, accountId));
          const [{ lastHour }] = await tx
            .select({ lastHour: count() })
            .from(tenants)
            .where(
              and(
                eq(tenants.createdByAccountId, accountId),
                gte(tenants.createdAt, new Date(input.now.getTime() - HOUR_MS)),
              ),
            );

          if (total >= input.maxCreatedTotal || lastHour >= input.maxCreatedPerHour) {
            const limit = total >= input.maxCreatedTotal ? "TOTAL" : "PER_HOUR";
            this.deps.logger.warn("Tenant creation refused: abuse limit reached", {
              account_id: accountId,
              error_code: "TENANT_LIMIT_REACHED",
              limit,
              created_total: total,
              created_last_hour: lastHour,
            });
            throw new AppError("TENANT_LIMIT_REACHED", {
              message: `Tenant creation cap hit (${limit})`,
              context: { account_id: accountId, limit },
            });
          }
        }

        const tenantRows = await tx
          .insert(tenants)
          .values({
            name,
            slug,
            status: "active",
            plan: "standard",
            createdByAccountId: accountId,
          })
          .returning({
            tenantId: tenants.id,
            name: tenants.name,
            slug: tenants.slug,
            plan: tenants.plan,
          });
        const tenant = tenantRows[0];

        await tx.insert(memberships).values({
          tenantId: tenant.tenantId,
          accountId,
          role: "owner",
          status: "active",
        });

        // The M1.1 invariant: one active membership ↔ one app_user, per tenant.
        await tx.insert(users).values({
          tenantId: tenant.tenantId,
          email: input.sessionEmail,
          name: input.displayName ?? input.sessionEmail,
          role: "owner",
          accountId,
        });

        await tx.insert(auditLogs).values({
          tenantId: tenant.tenantId,
          actorUserId: null,
          actorKind: "user",
          action: "tenant.created",
          entityType: "tenant",
          entityId: tenant.tenantId,
          payload: {
            slug,
            plan: "standard",
            actor_account_id: accountId,
            actor_email: input.sessionEmail,
          },
        });

        this.deps.logger.info("Tenant provisioned", {
          tenant_id: tenant.tenantId,
          account_id: accountId,
          slug,
        });

        return {
          tenantId: tenant.tenantId,
          name: tenant.name,
          slug: tenant.slug ?? slug,
          plan: tenant.plan,
        };
      });
    } catch (error) {
      // The slug unique key is a REFUSAL, not an outage.
      if (findPgError(error)?.code === "23505") {
        throw new AppError("SLUG_TAKEN", {
          message: "Another tenant already uses this slug",
          context: { account_id: accountId, slug },
          cause: error,
        });
      }
      throw wrapDbError(error, {
        operation: "tenantOnboarding.createTenant",
        field: "slug",
      });
    }
  }
}
