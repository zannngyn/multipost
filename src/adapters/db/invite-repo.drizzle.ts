import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type {
  ClaimInviteRecord,
  ClaimInviteResult,
  CreateInviteRecord,
  InviteListItem,
  InviteRepo,
  RevokeInviteRecord,
} from "@/core/ports/invite-repo";
import type { Logger } from "@/core/ports/infra";
import { isOperatorRole, type OperatorRole } from "@/shared/operator-access";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { auditLogs, identities, invites, memberships, tenants, users } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * `invite` persistence (M2.2, docs/09 §3.6).
 *
 * `claimInvite` is deliberately NOT behind `forTenant()`: the CLAIM is what
 * tells us which tenant the invite belongs to (same stance as `oauth_state`).
 * Every other method is tenant-scoped like any repo here.
 *
 * The claim locks the invite row (`FOR UPDATE`) for the length of the
 * decision: two racing browsers on a single-use link serialise on that lock,
 * and the second one finds `used_count = max_uses`.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRole(value: unknown): OperatorRole {
  if (isOperatorRole(value)) return value;
  throw new AppError("INTERNAL", {
    message: "invite.role holds an unknown value",
    context: { value: String(value), reason: "UNREADABLE_INVITE_ROW" },
  });
}

export class DrizzleInviteRepo implements InviteRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async listInvites(tenantId: TenantId): Promise<readonly InviteListItem[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      /**
       * `createdByEmail` comes from the creator's IDENTITY (session address):
       * `account` has no e-mail of its own, and the invite must stay readable
       * after the creator leaves (left join, null then).
       */
      const rows = await scope.db
        .select({
          id: invites.id,
          role: invites.role,
          expiresAt: invites.expiresAt,
          maxUses: invites.maxUses,
          usedCount: invites.usedCount,
          revokedAt: invites.revokedAt,
          createdByEmail: identities.sessionEmail,
        })
        .from(invites)
        .leftJoin(identities, eq(identities.accountId, invites.createdByAccountId))
        .where(scope.where(invites))
        .orderBy(desc(invites.createdAt));

      return rows.map((row) => ({
        id: row.id,
        role: readRole(row.role),
        expiresAt: row.expiresAt,
        maxUses: row.maxUses,
        usedCount: row.usedCount,
        revokedAt: row.revokedAt ?? null,
        createdByEmail: row.createdByEmail ?? null,
      }));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "invite.list",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async createInvite(input: CreateInviteRecord): Promise<{ id: string }> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const tokenHash = str(input?.tokenHash);
    const createdBy = str(input?.createdByAccountId);
    if (tokenHash.length < 32 || createdBy.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "createInvite requires a real token hash and a creator",
        context: { tenant_id: scope.tenantId, field: "tokenHash" },
      });
    }

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const rows = await tx
          .insert(invites)
          .values(
            txScope.row({
              tokenHash,
              role: input.role,
              expiresAt: input.expiresAt,
              maxUses: input.maxUses,
              createdByAccountId: createdBy,
            }),
          )
          .returning({ id: invites.id });

        await tx.insert(auditLogs).values(
          txScope.row({
            actorUserId: null,
            actorKind: "user" as const,
            action: "invite.created",
            entityType: "invite",
            entityId: rows[0].id,
            // Role + actor only. The token (and even its hash) stays out.
            payload: {
              invite_role: input.role,
              max_uses: input.maxUses,
              actor_account_id: createdBy,
              actor_email: input.actorEmail,
            },
          }),
        );
        return { id: rows[0].id };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "invite.create",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async revokeInvite(
    input: RevokeInviteRecord,
  ): Promise<"revoked" | "already_revoked" | "not_found"> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const id = str(input?.id);
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "revokeInvite requires an invite id",
        context: { tenant_id: scope.tenantId, field: "id" },
      });
    }

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        // Only an unrevoked row is touched — the WHERE is what makes a repeat
        // revoke idempotent without a second audit entry.
        const rows = await tx
          .update(invites)
          .set({ revokedAt: input.revokedAt })
          .where(txScope.where(invites, eq(invites.id, id), isNull(invites.revokedAt)))
          .returning({ id: invites.id });

        if (rows.length === 0) {
          const existing = await tx
            .select({ id: invites.id })
            .from(invites)
            .where(txScope.where(invites, eq(invites.id, id)))
            .limit(1);
          return existing.length > 0 ? "already_revoked" : "not_found";
        }

        await tx.insert(auditLogs).values(
          txScope.row({
            actorUserId: null,
            actorKind: "user" as const,
            action: "invite.revoked",
            entityType: "invite",
            entityId: id,
            payload: {
              actor_account_id: input.actorAccountId,
              actor_email: input.actorEmail,
            },
          }),
        );
        return "revoked";
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "invite.revoke",
        tenant_id: scope.tenantId,
        invite_id: id,
        field: "id",
      });
    }
  }

  async claimInvite(input: ClaimInviteRecord): Promise<ClaimInviteResult> {
    const tokenHash = str(input?.tokenHash);
    const accountId = str(input?.accountId);
    const sessionEmail = str(input?.sessionEmail).toLowerCase();
    if (tokenHash.length < 32 || accountId.length === 0 || sessionEmail.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "claimInvite requires tokenHash, accountId and sessionEmail",
        context: { field: "tokenHash" },
      });
    }

    try {
      return await this.db.transaction(async (tx): Promise<ClaimInviteResult> => {
        /**
         * Row-locked for the whole decision: the racing second claim of a
         * single-use link waits here, then reads used_count == max_uses.
         */
        const inviteRows = await tx
          .select()
          .from(invites)
          .where(eq(invites.tokenHash, tokenHash))
          .limit(1)
          .for("update");
        const invite = inviteRows[0];

        // --- Refusals first, ONE code outside, exact reason in the log ------
        if (!invite) return { kind: "invalid", reason: "UNKNOWN_TOKEN" };
        if (invite.revokedAt) return { kind: "invalid", reason: "REVOKED" };
        if (invite.expiresAt.getTime() <= input.now.getTime()) {
          return { kind: "invalid", reason: "EXPIRED" };
        }
        if (invite.usedCount >= invite.maxUses) return { kind: "invalid", reason: "USED_UP" };

        const tenantRows = await tx
          .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, plan: tenants.plan, status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, invite.tenantId))
          .limit(1);
        const tenant = tenantRows[0];
        if (!tenant || tenant.status !== "active") {
          return { kind: "invalid", reason: "TENANT_SUSPENDED" };
        }
        const tenantSummary = {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug ?? null,
          plan: tenant.plan,
        };

        const membershipRows = await tx
          .select({ id: memberships.id, status: memberships.status, role: memberships.role })
          .from(memberships)
          .where(
            and(eq(memberships.tenantId, invite.tenantId), eq(memberships.accountId, accountId)),
          )
          .limit(1)
          .for("update");
        const existing = membershipRows[0];

        // Already a member → no-op WITH an answer, and no use burned (§3.6).
        if (existing && existing.status === "active") {
          return {
            kind: "already_member",
            tenant: tenantSummary,
            role: readRole(existing.role),
          };
        }

        const role = readRole(invite.role);

        // Burn the use INSIDE the same transaction as the membership write.
        await tx
          .update(invites)
          .set({ usedCount: invite.usedCount + 1 })
          .where(eq(invites.id, invite.id));

        if (existing) {
          // Revive the REMOVED row (never a second one): role from the invite,
          // version bump so every cache in the fleet notices.
          await tx
            .update(memberships)
            .set({ role, status: "active", version: sql`${memberships.version} + 1` })
            .where(eq(memberships.id, existing.id));
        } else {
          await tx.insert(memberships).values({
            tenantId: invite.tenantId,
            accountId,
            role,
            status: "active",
          });
        }

        // The M1.1 invariant, same shape as the approve path.
        await tx
          .insert(users)
          .values({
            tenantId: invite.tenantId,
            email: sessionEmail,
            name: input.displayName ?? sessionEmail,
            role,
            accountId,
          })
          .onConflictDoUpdate({
            target: [users.tenantId, users.email],
            set: { role, accountId, updatedAt: new Date() },
          });

        await tx.insert(auditLogs).values({
          tenantId: invite.tenantId,
          actorUserId: null,
          actorKind: "user",
          action: "invite.accepted",
          entityType: "invite",
          entityId: invite.id,
          payload: {
            invite_role: role,
            invited_by_account_id: invite.createdByAccountId,
            actor_account_id: accountId,
            actor_email: sessionEmail,
            revived_membership: existing !== undefined,
          },
        });

        this.deps.logger.info("Invite accepted", {
          tenant_id: invite.tenantId,
          invite_id: invite.id,
          account_id: accountId,
          membership_role: role,
        });

        return { kind: "joined", tenant: tenantSummary, role };
      });
    } catch (error) {
      throw wrapDbError(error, { operation: "invite.claim", field: "tokenHash" });
    }
  }
}
