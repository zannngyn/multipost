import { and, eq, gt, isNull } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type {
  CloseSupportSessionRecord,
  LiveSupportSession,
  OpenedSupportSession,
  OpenSupportSessionRecord,
  SupportSessionRepo,
} from "@/core/ports/support-session-repo";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { auditLogs, platformAccessSessions, tenants } from "./schema";

/**
 * `platform_access_session` persistence (M3.3). NOT behind `forTenant()` —
 * this is the platform layer entering tenants from outside; the audit rows it
 * writes ARE tenant-scoped (the customer's book), the session rows are not.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class DrizzleSupportSessionRepo implements SupportSessionRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async open(input: OpenSupportSessionRecord): Promise<OpenedSupportSession> {
    const accountId = str(input?.accountId);
    const purpose = str(input?.purpose);
    if (accountId.length === 0 || purpose.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "open requires accountId and purpose",
        context: { tenant_id: input?.tenantId ?? null, field: accountId ? "purpose" : "accountId" },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        // --- Edge case first: support enters LIVING companies only ----------
        const tenantRows = await tx
          .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, input.tenantId))
          .limit(1);
        const tenant = tenantRows[0];
        if (!tenant || tenant.status !== "active") {
          throw new AppError("TENANT_NOT_FOUND", {
            message: "No active tenant with that id",
            context: { tenant_id: input.tenantId },
          });
        }

        /**
         * One visit at a time, never nested (docs/09 §3.5): every live session
         * of this account is revoked — and its EXIT is booked — before the new
         * one opens. Both books stay truthful: the old tenant sees the leave,
         * the new one sees the entry.
         */
        const revoked = await tx
          .update(platformAccessSessions)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(platformAccessSessions.accountId, accountId),
              isNull(platformAccessSessions.revokedAt),
              gt(platformAccessSessions.expiresAt, input.now),
            ),
          )
          .returning({ id: platformAccessSessions.id, tenantId: platformAccessSessions.tenantId });
        for (const old of revoked) {
          await tx.insert(auditLogs).values({
            tenantId: old.tenantId,
            actorUserId: null,
            actorKind: "platform_support",
            action: "platform.exited_tenant",
            entityType: "platform_access_session",
            entityId: old.id,
            payload: {
              reason: "REPLACED_BY_NEW_SESSION",
              actor_account_id: accountId,
              actor_email: input.actorEmail,
            },
          });
        }

        const rows = await tx
          .insert(platformAccessSessions)
          .values({
            accountId,
            tenantId: input.tenantId,
            purpose,
            expiresAt: input.expiresAt,
          })
          .returning({ id: platformAccessSessions.id });
        const sessionId = rows[0].id;

        // The customer's book shows the entry THE MOMENT it happens.
        await tx.insert(auditLogs).values({
          tenantId: input.tenantId,
          actorUserId: null,
          actorKind: "platform_support",
          action: "platform.entered_tenant",
          entityType: "platform_access_session",
          entityId: sessionId,
          payload: {
            purpose,
            actor_account_id: accountId,
            actor_email: input.actorEmail,
            expires_at: input.expiresAt.toISOString(),
          },
        });

        this.deps.logger.info("Support session opened", {
          tenant_id: input.tenantId,
          account_id: accountId,
          session_id: sessionId,
          replaced_sessions: revoked.length,
        });

        return {
          sessionId,
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug ?? null },
          expiresAt: input.expiresAt,
        };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "supportSession.open",
        tenant_id: input?.tenantId ?? null,
        field: "tenantId",
      });
    }
  }

  async findLive(
    sessionId: string,
    accountId: string,
    now: Date,
  ): Promise<LiveSupportSession | null> {
    const id = str(sessionId);
    const account = str(accountId);
    // Garbage in the cookie is a refusal, not a Postgres cast error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    if (account.length === 0) return null;

    try {
      const rows = await this.db
        .select({
          sessionId: platformAccessSessions.id,
          tenantId: platformAccessSessions.tenantId,
          expiresAt: platformAccessSessions.expiresAt,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          tenantStatus: tenants.status,
        })
        .from(platformAccessSessions)
        .innerJoin(tenants, eq(tenants.id, platformAccessSessions.tenantId))
        .where(
          and(
            eq(platformAccessSessions.id, id),
            eq(platformAccessSessions.accountId, account),
            isNull(platformAccessSessions.revokedAt),
            gt(platformAccessSessions.expiresAt, now),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      // A tenant suspended mid-visit closes the door with it.
      if (row.tenantStatus !== "active") return null;

      return {
        sessionId: row.sessionId,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        tenantSlug: row.tenantSlug ?? null,
        expiresAt: row.expiresAt,
      };
    } catch (error) {
      throw wrapDbError(error, { operation: "supportSession.findLive", field: "sessionId" });
    }
  }

  async close(input: CloseSupportSessionRecord): Promise<"closed" | "already_closed" | "not_found"> {
    const id = str(input?.sessionId);
    const account = str(input?.accountId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return "not_found";
    }
    if (account.length === 0) return "not_found";

    try {
      return await this.db.transaction(async (tx) => {
        // Only an unrevoked row is touched — repeat closes stay silent in the
        // audit book (one exit per visit, not one per double-click).
        const rows = await tx
          .update(platformAccessSessions)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(platformAccessSessions.id, id),
              eq(platformAccessSessions.accountId, account),
              isNull(platformAccessSessions.revokedAt),
            ),
          )
          .returning({ id: platformAccessSessions.id, tenantId: platformAccessSessions.tenantId });

        if (rows.length === 0) {
          const existing = await tx
            .select({ id: platformAccessSessions.id })
            .from(platformAccessSessions)
            .where(
              and(
                eq(platformAccessSessions.id, id),
                eq(platformAccessSessions.accountId, account),
              ),
            )
            .limit(1);
          return existing.length > 0 ? "already_closed" : "not_found";
        }

        await tx.insert(auditLogs).values({
          tenantId: rows[0].tenantId,
          actorUserId: null,
          actorKind: "platform_support",
          action: "platform.exited_tenant",
          entityType: "platform_access_session",
          entityId: id,
          payload: {
            reason: "EXITED",
            actor_account_id: account,
            actor_email: input.actorEmail,
          },
        });

        this.deps.logger.info("Support session closed", {
          tenant_id: rows[0].tenantId,
          account_id: account,
          session_id: id,
        });
        return "closed";
      });
    } catch (error) {
      throw wrapDbError(error, { operation: "supportSession.close", field: "sessionId" });
    }
  }
}
