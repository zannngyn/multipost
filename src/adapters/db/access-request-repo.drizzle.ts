import { and, desc, eq, sql } from "drizzle-orm";

import type { AccessRequest } from "@/core/domain/access-request";
import { AppError } from "@/core/domain/errors";
import type {
  AccessRequestRepo,
  CreatePendingAccessRequestInput,
  DecideAccessRequestRecord,
} from "@/core/ports/access-request-repo";
import type { Logger } from "@/core/ports/infra";
import {
  isAccessStatus,
  isOperatorProvider,
  isOperatorRole,
  type AccessStatus,
  type OperatorProvider,
} from "@/shared/operator-access";

import type { Database, DbExecutor } from "./client";
import { findPgError, wrapDbError } from "./db-errors";
import { accessRequests, auditLogs, users, type AccessRequestRow } from "./schema";
import { forTenant, type TenantScopedDb } from "./tenant-scope";

/**
 * `access_request` persistence (E1.4).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. `createPending` is an UPSERT, not read-then-insert. Two tabs finishing the
 *    OAuth round trip at the same moment is a normal race; a duplicate-key
 *    error on it would show the operator a 500 for succeeding twice.
 * 2. `decide` runs registry row + `app_user` + `audit_log` in ONE transaction.
 *    An approval that granted access without leaving a trail is exactly the
 *    change nobody can reconstruct afterwards (CLAUDE.md rule 4/6).
 */

function toDomain(row: AccessRequestRow): AccessRequest {
  return {
    id: row.id,
    tenantId: row.tenantId,
    // A hand-edited row could hold anything; an unreadable enum must not be
    // silently coerced into "google"/"approved" — the safe reading is refusal.
    provider: readProvider(row.provider),
    providerAccountId: row.providerAccountId,
    sessionEmail: row.sessionEmail,
    email: row.email ?? null,
    displayName: row.displayName ?? null,
    status: readStatus(row.status),
    role: isOperatorRole(row.role) ? row.role : null,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt ?? null,
    decidedByEmail: row.decidedByEmail ?? null,
  };
}

function readProvider(value: unknown): OperatorProvider {
  if (isOperatorProvider(value)) return value;
  throw new AppError("INTERNAL", {
    message: "access_request.provider holds an unknown value",
    context: { provider: String(value), reason: "UNREADABLE_ACCESS_ROW" },
  });
}

function readStatus(value: unknown): AccessStatus {
  if (isAccessStatus(value)) return value;
  throw new AppError("INTERNAL", {
    message: "access_request.status holds an unknown value",
    context: { access_status: String(value), reason: "UNREADABLE_ACCESS_ROW" },
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** SQLSTATE 23505 — unique_violation, anywhere in the cause chain. */
function isUniqueViolation(error: unknown): boolean {
  return findPgError(error)?.code === "23505";
}

function missingField(tenantId: string, operation: string, field: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: `${operation} requires ${field}`,
    userMessage: "Thiếu thông tin định danh tài khoản.",
    context: { tenant_id: tenantId, operation, field },
  });
}

export class DrizzleAccessRequestRepo implements AccessRequestRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async findByProviderAccount(
    tenantId: string,
    provider: OperatorProvider,
    providerAccountId: string,
  ): Promise<AccessRequest | null> {
    const scope = forTenant(this.db, tenantId);
    // --- Edge cases first ---------------------------------------------------
    if (!isOperatorProvider(provider)) {
      throw missingField(scope.tenantId, "accessRequest.findByProviderAccount", "provider");
    }
    const accountId = str(providerAccountId);
    if (accountId.length === 0) {
      throw missingField(
        scope.tenantId,
        "accessRequest.findByProviderAccount",
        "providerAccountId",
      );
    }

    try {
      const rows = await scope.db
        .select()
        .from(accessRequests)
        .where(
          scope.where(
            accessRequests,
            and(
              eq(accessRequests.provider, provider),
              eq(accessRequests.providerAccountId, accountId),
            ),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "accessRequest.findByProviderAccount",
        tenant_id: scope.tenantId,
        provider,
        field: "tenantId",
      });
    }
  }

  async findBySessionEmail(tenantId: string, sessionEmail: string): Promise<AccessRequest | null> {
    const scope = forTenant(this.db, tenantId);
    const email = str(sessionEmail).toLowerCase();
    if (email.length === 0) {
      throw missingField(scope.tenantId, "accessRequest.findBySessionEmail", "sessionEmail");
    }

    try {
      const rows = await scope.db
        .select()
        .from(accessRequests)
        .where(
          scope.where(
            accessRequests,
            eq(sql`lower(${accessRequests.sessionEmail})`, email),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "accessRequest.findBySessionEmail",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async createPending(input: CreatePendingAccessRequestInput): Promise<AccessRequest> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const identity = input?.identity;
    const accountId = str(identity?.providerAccountId);
    const sessionEmail = str(identity?.sessionEmail).toLowerCase();
    if (!isOperatorProvider(identity?.provider) || accountId.length === 0 || sessionEmail.length === 0) {
      throw missingField(scope.tenantId, "accessRequest.createPending", "identity");
    }

    try {
      /**
       * `onConflictDoUpdate` on the identity key, refreshing only the display
       * fields: signing in again may bring a name the provider did not have the
       * first time, and MUST NOT reset a decision already taken. Status and
       * role are deliberately absent from the SET clause.
       */
      const rows = await scope.db
        .insert(accessRequests)
        .values(
          scope.row({
            provider: identity.provider,
            providerAccountId: accountId,
            sessionEmail,
            email: identity.email ?? null,
            displayName: identity.displayName ?? null,
            status: "pending" as const,
            requestedAt: input?.requestedAt ?? new Date(),
          }),
        )
        .onConflictDoUpdate({
          target: [
            accessRequests.tenantId,
            accessRequests.provider,
            accessRequests.providerAccountId,
          ],
          set: {
            displayName: sql`coalesce(excluded.display_name, ${accessRequests.displayName})`,
            email: sql`coalesce(excluded.email, ${accessRequests.email})`,
            updatedAt: new Date(),
          },
        })
        .returning();

      const row = rows[0];
      if (!row) {
        throw new AppError("DB_ERROR", {
          message: "Upserting an access request returned no row",
          context: { tenant_id: scope.tenantId, provider: identity.provider },
        });
      }
      return toDomain(row);
    } catch (error) {
      /**
       * Unique violation on (tenant, session_email): another identity already
       * signs in under this address. Reported as a caller problem, not as
       * "database down" — a 503 would tell the operator to retry something that
       * retrying can never fix.
       */
      if (isUniqueViolation(error)) {
        throw new AppError("INVALID_INPUT", {
          message: "Another identity already uses this session address",
          userMessage:
            "Địa chỉ đăng nhập này đã thuộc về một tài khoản khác trong hệ thống. Liên hệ quản trị viên.",
          context: {
            tenant_id: scope.tenantId,
            provider: identity.provider,
            field: "sessionEmail",
            reason: "SESSION_EMAIL_TAKEN",
          },
          cause: error,
        });
      }
      throw wrapDbError(error, {
        operation: "accessRequest.createPending",
        tenant_id: scope.tenantId,
        provider: identity.provider,
        field: "tenantId",
      });
    }
  }

  async list(tenantId: string, status: AccessStatus | "all"): Promise<readonly AccessRequest[]> {
    const scope = forTenant(this.db, tenantId);
    const filter = status === "all" || isAccessStatus(status) ? status : "pending";

    try {
      const rows = await scope.db
        .select()
        .from(accessRequests)
        .where(
          scope.where(
            accessRequests,
            filter === "all" ? undefined : eq(accessRequests.status, filter),
          ),
        )
        .orderBy(desc(accessRequests.requestedAt));
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "accessRequest.list",
        tenant_id: scope.tenantId,
        access_filter: filter,
        field: "tenantId",
      });
    }
  }

  async decide(input: DecideAccessRequestRecord): Promise<AccessRequest | null> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const id = str(input?.id);
    if (id.length === 0) throw missingField(scope.tenantId, "accessRequest.decide", "id");
    if (input?.status !== "approved" && input?.status !== "blocked") {
      throw missingField(scope.tenantId, "accessRequest.decide", "status");
    }
    if (input.status === "approved" && !isOperatorRole(input?.role)) {
      throw missingField(scope.tenantId, "accessRequest.decide", "role");
    }

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const current = await this.readForUpdate(txScope, id);
        if (!current) return null;

        const decidedAt = input.decidedAt ?? new Date();
        const rows = await txScope.db
          .update(accessRequests)
          .set({
            status: input.status,
            // A block clears the role: re-approving always names one, so keeping
            // a stale role would only show "Đã chặn · Editor" on the screen.
            role: input.status === "approved" && isOperatorRole(input.role) ? input.role : null,
            decidedAt,
            decidedByUserId: str(input?.decidedByUserId) || null,
            decidedByEmail: str(input?.decidedByEmail).toLowerCase() || null,
          })
          .where(txScope.where(accessRequests, eq(accessRequests.id, id)))
          .returning();

        const updated = rows[0];
        if (!updated) return null;

        if (input.status === "approved" && isOperatorRole(input.role)) {
          await this.upsertOperator(txScope, current, input.role);
        }

        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: str(input?.decidedByUserId) || null,
            action: input.status === "approved" ? "access_request.approved" : "access_request.blocked",
            entityType: "access_request",
            entityId: id,
            // Identity + decision only. No token, no secret, ever.
            payload: {
              provider: current.provider,
              provider_account_id: current.providerAccountId,
              session_email: current.sessionEmail,
              previous_status: current.status,
              new_status: input.status,
              role: input.status === "approved" ? input.role : null,
              actor_email: str(input?.decidedByEmail).toLowerCase() || null,
            },
          }),
        );

        this.deps.logger.info("Access decision written", {
          tenant_id: txScope.tenantId,
          access_request_id: id,
          provider: current.provider,
          previous_status: current.status,
          new_status: input.status,
        });

        return toDomain(updated);
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "accessRequest.decide",
        tenant_id: scope.tenantId,
        access_request_id: id,
        field: "id",
      });
    }
  }

  /** Row locked for the length of the decision, so two admins cannot interleave. */
  private async readForUpdate(
    scope: TenantScopedDb<DbExecutor>,
    id: string,
  ): Promise<AccessRequest | null> {
    const rows = await scope.db
      .select()
      .from(accessRequests)
      .where(scope.where(accessRequests, eq(accessRequests.id, id)))
      .limit(1)
      .for("update");
    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  /**
   * An approved identity becomes an `app_user`: that row is what the audit
   * trail, the compose drafts and every "ai bấm nút này" lookup are keyed by.
   * Filed under the SESSION address (`app_user.email` is NOT NULL and the
   * provider one may be absent), which is also what `getOperatorSession` hands
   * to `findUserIdByEmail`.
   */
  private async upsertOperator(
    scope: TenantScopedDb<DbExecutor>,
    request: AccessRequest,
    role: NonNullable<AccessRequest["role"]>,
  ): Promise<void> {
    await scope.db
      .insert(users)
      .values(
        scope.row({
          email: request.sessionEmail,
          name: request.displayName ?? request.sessionEmail,
          role,
        }),
      )
      .onConflictDoUpdate({
        target: [users.tenantId, users.email],
        set: { role, updatedAt: new Date() },
      });
  }
}
