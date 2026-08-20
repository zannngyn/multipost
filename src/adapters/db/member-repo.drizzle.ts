import { and, asc, count, eq, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import { canChangeMemberRole, canRemoveMember } from "@/core/domain/member-policy";
import type { TenantId } from "@/core/domain/tenant-context";
import type {
  ChangeMemberRoleRecord,
  MemberChangeResult,
  MemberListItem,
  MemberRepo,
  RemoveMemberRecord,
} from "@/core/ports/member-repo";
import type { Logger } from "@/core/ports/infra";
import { isOperatorRole, type OperatorRole } from "@/shared/operator-access";

import type { Database, DbExecutor } from "./client";
import { wrapDbError } from "./db-errors";
import { accounts, auditLogs, identities, memberships, postDrafts, users } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * Member management (M2.3). The two rules that MUST be transactional live here:
 *   - the ladder (pure functions from core/domain/member-policy) — checked
 *     against the target's CURRENT role (`FOR UPDATE`-locked), not the one the
 *     caller saw a screen refresh ago;
 *   - LAST_OWNER — the active-owner count, taken inside the same transaction.
 *
 * The row lock alone is NOT enough for LAST_OWNER: two owners demoting EACH
 * OTHER lock two different rows, and under READ COMMITTED each still counts
 * the other as active — both pass, zero owners remain. So every member
 * mutation of one tenant serialises on a per-tenant advisory lock first (the
 * same pattern as tenant creation in tenant-onboarding-repo): the second
 * transaction waits, then counts a world where the first one already happened.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRole(value: unknown): OperatorRole {
  if (isOperatorRole(value)) return value;
  throw new AppError("INTERNAL", {
    message: "membership.role holds an unknown value",
    context: { value: String(value), reason: "UNREADABLE_MEMBER_ROW" },
  });
}

function memberNotFound(tenantId: string, membershipId: string): AppError {
  return new AppError("MEMBER_NOT_FOUND", {
    message: "No active membership with that id in this tenant",
    context: { tenant_id: tenantId, membership_id: membershipId },
  });
}


/**
 * Serialises every member mutation of ONE tenant. Taken as the first statement
 * of both write transactions; released automatically at commit/rollback.
 */
async function lockTenantMembers(tx: DbExecutor, tenantId: TenantId): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tenant_members:${tenantId}`}))`);
}

export class DrizzleMemberRepo implements MemberRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async listMembers(tenantId: TenantId): Promise<readonly MemberListItem[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select({
          membershipId: memberships.id,
          accountId: memberships.accountId,
          displayName: accounts.displayName,
          // The ATTRIBUTE address (nullable, Facebook may have none) — the
          // session key (identity.session_email) deliberately stays server-side.
          email: identities.email,
          role: memberships.role,
          joinedAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(accounts, eq(accounts.id, memberships.accountId))
        .leftJoin(identities, eq(identities.accountId, memberships.accountId))
        .where(scope.where(memberships, eq(memberships.status, "active")))
        .orderBy(asc(memberships.createdAt));

      return rows.map((row) => ({
        membershipId: row.membershipId,
        accountId: row.accountId,
        displayName: row.displayName ?? null,
        email: row.email ?? null,
        role: readRole(row.role),
        joinedAt: row.joinedAt,
      }));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "member.list",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async changeRole(input: ChangeMemberRoleRecord): Promise<MemberChangeResult> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const membershipId = str(input?.membershipId);
    if (membershipId.length === 0 || !isOperatorRole(input?.newRole)) {
      throw new AppError("INVALID_INPUT", {
        message: "changeRole requires a membership id and a known role",
        context: { tenant_id: scope.tenantId, field: "membershipId" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // FIRST: the per-tenant mutation lock — see the module header for the
        // two-owners-demoting-each-other race the row lock cannot stop.
        await lockTenantMembers(tx, input.tenantId);
        const target = await this.lockActiveMembership(tx, input.tenantId, membershipId);
        if (!target) throw memberNotFound(scope.tenantId, membershipId);
        const targetRole = readRole(target.role);

        // --- Refusals first -------------------------------------------------
        const verdict = canChangeMemberRole(input.actorRole, targetRole, input.newRole);
        if (!verdict.allowed) {
          this.deps.logger.warn("Role change refused by the ladder", {
            tenant_id: scope.tenantId,
            membership_id: membershipId,
            error_code: "FORBIDDEN",
            actor_role: input.actorRole,
            target_role: targetRole,
            requested_role: input.newRole,
          });
          throw new AppError("FORBIDDEN", {
            message: `Role '${input.actorRole}' may not move '${targetRole}' to '${input.newRole}'`,
            context: { tenant_id: scope.tenantId, membership_id: membershipId },
          });
        }
        if (targetRole === "owner" && input.newRole !== "owner") {
          await this.assertNotLastOwner(tx, input.tenantId, membershipId);
        }

        // Same role again: an idempotent success — no bump, no audit noise.
        if (targetRole === input.newRole) {
          return {
            membershipId,
            accountId: target.accountId,
            role: targetRole,
            version: target.version,
          };
        }

        const updated = await tx
          .update(memberships)
          .set({ role: input.newRole, version: sql`${memberships.version} + 1` })
          .where(eq(memberships.id, membershipId))
          .returning({ version: memberships.version });

        // Keep the domain actor in step (the M1.1 invariant).
        await tx
          .update(users)
          .set({ role: input.newRole })
          .where(and(eq(users.tenantId, scope.tenantId), eq(users.accountId, target.accountId)));

        await tx.insert(auditLogs).values({
          tenantId: input.tenantId,
          actorUserId: null,
          actorKind: "user",
          action: "member.role_changed",
          entityType: "membership",
          entityId: membershipId,
          payload: {
            target_account_id: target.accountId,
            old_role: targetRole,
            new_role: input.newRole,
            actor_account_id: input.actorAccountId,
            actor_email: input.actorEmail,
          },
        });

        this.deps.logger.info("Member role changed", {
          tenant_id: scope.tenantId,
          membership_id: membershipId,
          old_role: targetRole,
          new_role: input.newRole,
        });

        return {
          membershipId,
          accountId: target.accountId,
          role: input.newRole,
          version: updated[0].version,
        };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "member.changeRole",
        tenant_id: scope.tenantId,
        membership_id: membershipId,
        field: "membershipId",
      });
    }
  }

  async removeMember(input: RemoveMemberRecord): Promise<MemberChangeResult> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const membershipId = str(input?.membershipId);
    if (membershipId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "removeMember requires a membership id",
        context: { tenant_id: scope.tenantId, field: "membershipId" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // FIRST: the per-tenant mutation lock — demote+remove combinations
        // race exactly like demote+demote (see the module header).
        await lockTenantMembers(tx, input.tenantId);
        const target = await this.lockActiveMembership(tx, input.tenantId, membershipId);
        if (!target) throw memberNotFound(scope.tenantId, membershipId);
        const targetRole = readRole(target.role);
        const isSelf = target.accountId === input.actorAccountId;

        // --- Refusals first -------------------------------------------------
        const verdict = canRemoveMember(input.actorRole, targetRole, isSelf);
        if (!verdict.allowed) {
          this.deps.logger.warn("Member removal refused by the ladder", {
            tenant_id: scope.tenantId,
            membership_id: membershipId,
            error_code: "FORBIDDEN",
            actor_role: input.actorRole,
            target_role: targetRole,
          });
          throw new AppError("FORBIDDEN", {
            message: `Role '${input.actorRole}' may not remove a '${targetRole}'`,
            context: { tenant_id: scope.tenantId, membership_id: membershipId },
          });
        }
        if (targetRole === "owner") {
          await this.assertNotLastOwner(tx, input.tenantId, membershipId);
        }

        const updated = await tx
          .update(memberships)
          .set({ status: "removed", version: sql`${memberships.version} + 1` })
          .where(eq(memberships.id, membershipId))
          .returning({ version: memberships.version });

        /**
         * Doc 10 §8.8 (c): a removed member's server-side drafts go with them —
         * no API reads another person's draft, so keeping them would only
         * leak on a future revive with a different role.
         */
        const operatorRows = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.tenantId, scope.tenantId), eq(users.accountId, target.accountId)));
        if (operatorRows.length > 0) {
          await tx.delete(postDrafts).where(
            and(
              eq(postDrafts.tenantId, input.tenantId),
              eq(postDrafts.ownerUserId, operatorRows[0].id),
            ),
          );
        }

        await tx.insert(auditLogs).values({
          tenantId: input.tenantId,
          actorUserId: null,
          actorKind: "user",
          action: "member.removed",
          entityType: "membership",
          entityId: membershipId,
          payload: {
            target_account_id: target.accountId,
            target_role: targetRole,
            left_by_self: isSelf,
            actor_account_id: input.actorAccountId,
            actor_email: input.actorEmail,
          },
        });

        this.deps.logger.info("Member removed", {
          tenant_id: scope.tenantId,
          membership_id: membershipId,
          target_role: targetRole,
          left_by_self: isSelf,
        });

        return {
          membershipId,
          accountId: target.accountId,
          role: targetRole,
          version: updated[0].version,
        };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "member.remove",
        tenant_id: scope.tenantId,
        membership_id: membershipId,
        field: "membershipId",
      });
    }
  }

  /** The target row, locked for the length of the decision. Null = not here. */
  private async lockActiveMembership(
    tx: DbExecutor,
    tenantId: TenantId,
    membershipId: string,
  ): Promise<{ accountId: string; role: unknown; version: number } | null> {
    const rows = await tx
      .select({
        accountId: memberships.accountId,
        role: memberships.role,
        version: memberships.version,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.id, membershipId),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  }

  /**
   * LAST_OWNER: would this change leave zero active owners? Counted INSIDE the
   * transaction — the whole reason this rule lives in the adapter.
   */
  private async assertNotLastOwner(
    tx: DbExecutor,
    tenantId: TenantId,
    excludingMembershipId: string,
  ): Promise<void> {
    const [{ others }] = await tx
      .select({ others: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.role, "owner"),
          eq(memberships.status, "active"),
          sql`${memberships.id} <> ${excludingMembershipId}`,
        ),
      );
    if (others === 0) {
      throw new AppError("LAST_OWNER", {
        message: "Change would leave the tenant with zero active owners",
        context: { tenant_id: tenantId, membership_id: excludingMembershipId },
      });
    }
  }
}
