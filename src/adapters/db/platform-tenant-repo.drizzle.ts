import { and, count, desc, eq } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import { isTenantStatus } from "@/core/domain/tenant";
import type {
  PlatformCreatedTenant,
  PlatformCreateTenantRecord,
  PlatformTenantListItem,
  PlatformTenantRepo,
  SetTenantStatusRecord,
  SetTenantStatusResult,
} from "@/core/ports/platform-tenant-repo";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { findPgError, wrapDbError } from "./db-errors";
import { auditLogs, memberships, tenants } from "./schema";

/**
 * Platform tenant administration (M3.2). NOT behind `forTenant()` — this IS
 * the layer that administers tenants from outside, the one place allowed to
 * see all of them (docs/09 §3.5). Every mutation is audited under the TARGET
 * tenant with the caller's reason.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class DrizzlePlatformTenantRepo implements PlatformTenantRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async listTenants(): Promise<readonly PlatformTenantListItem[]> {
    try {
      const rows = await this.db
        .select({
          id: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          plan: tenants.plan,
          status: tenants.status,
          createdAt: tenants.createdAt,
          memberCount: count(memberships.id),
        })
        .from(tenants)
        .leftJoin(
          memberships,
          and(eq(memberships.tenantId, tenants.id), eq(memberships.status, "active")),
        )
        .groupBy(tenants.id)
        .orderBy(desc(tenants.createdAt));

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug ?? null,
        plan: row.plan,
        status: readStatus(row.status),
        memberCount: row.memberCount,
        createdAt: row.createdAt,
      }));
    } catch (error) {
      throw wrapDbError(error, { operation: "platformTenant.list" });
    }
  }

  async createTenant(input: PlatformCreateTenantRecord): Promise<PlatformCreatedTenant> {
    const name = str(input?.name);
    const slug = str(input?.slug).toLowerCase();
    if (name.length === 0 || slug.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Platform tenant creation requires name and slug",
        context: { field: name ? "slug" : "name" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // NO membership on purpose: MYSP staff are not members of a customer's
        // company — the owner arrives through the invite minted right after.
        const rows = await tx
          .insert(tenants)
          .values({
            name,
            slug,
            status: "active",
            plan: input.plan,
            createdByAccountId: input.actorAccountId,
          })
          .returning({
            id: tenants.id,
            name: tenants.name,
            slug: tenants.slug,
            plan: tenants.plan,
            status: tenants.status,
          });
        const tenant = rows[0];

        await tx.insert(auditLogs).values({
          tenantId: tenant.id,
          actorUserId: null,
          actorKind: "user",
          action: "platform.tenant_created",
          entityType: "tenant",
          entityId: tenant.id,
          payload: {
            slug,
            plan: input.plan,
            platform_role: "super_admin",
            actor_account_id: input.actorAccountId,
            actor_email: input.actorEmail,
          },
        });

        this.deps.logger.info("Tenant created by platform admin", {
          tenant_id: tenant.id,
          slug,
          plan: input.plan,
        });

        return {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug ?? slug,
          plan: tenant.plan,
          status: readStatus(tenant.status),
        };
      });
    } catch (error) {
      if (findPgError(error)?.code === "23505") {
        throw new AppError("SLUG_TAKEN", {
          message: "Another tenant already uses this slug",
          context: { slug },
          cause: error,
        });
      }
      throw wrapDbError(error, { operation: "platformTenant.create", field: "slug" });
    }
  }

  async setStatus(input: SetTenantStatusRecord): Promise<SetTenantStatusResult> {
    const reason = str(input?.reason);
    if (!isTenantStatus(input?.status) || reason.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "setStatus requires a valid status and a reason",
        context: { tenant_id: input?.tenantId ?? null, field: "status" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select({ status: tenants.status, plan: tenants.plan })
          .from(tenants)
          .where(eq(tenants.id, input.tenantId))
          .limit(1)
          .for("update");
        const tenant = current[0];
        if (!tenant) {
          throw new AppError("TENANT_NOT_FOUND", {
            message: "No tenant with that id",
            context: { tenant_id: input.tenantId },
          });
        }

        // Idempotent: already there → nothing changes, no audit noise.
        if (tenant.status === input.status) {
          return { tenantId: input.tenantId, status: input.status, already: true };
        }

        /**
         * Suspending MYSP's own (`internal`) tenant is legal — locking your
         * own house is a real operation — but it deserves a flare in the log
         * before anyone wonders why every dashboard died.
         */
        if (input.status === "suspended" && tenant.plan === "internal") {
          this.deps.logger.warn("Suspending an INTERNAL (platform-owned) tenant", {
            tenant_id: input.tenantId,
            alert: "OPERATOR_ATTENTION",
          });
        }

        await tx
          .update(tenants)
          .set({ status: input.status })
          .where(eq(tenants.id, input.tenantId));

        await tx.insert(auditLogs).values({
          tenantId: input.tenantId,
          actorUserId: null,
          actorKind: "user",
          action:
            input.status === "suspended"
              ? "platform.tenant_suspended"
              : "platform.tenant_activated",
          entityType: "tenant",
          entityId: input.tenantId,
          payload: {
            reason,
            platform_role: "super_admin",
            actor_account_id: input.actorAccountId,
            actor_email: input.actorEmail,
          },
        });

        this.deps.logger.info("Tenant status changed by platform admin", {
          tenant_id: input.tenantId,
          new_status: input.status,
          reason,
        });

        return { tenantId: input.tenantId, status: input.status, already: false };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "platformTenant.setStatus",
        tenant_id: input?.tenantId ?? null,
        field: "tenantId",
      });
    }
  }
}

function readStatus(value: unknown): "active" | "suspended" {
  if (isTenantStatus(value)) return value;
  throw new AppError("INTERNAL", {
    message: "tenant.status holds an unknown value",
    context: { value: String(value), reason: "UNREADABLE_TENANT_ROW" },
  });
}
