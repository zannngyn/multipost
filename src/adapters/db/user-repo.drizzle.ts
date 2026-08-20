import { eq, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { UserRepo } from "@/core/ports/user-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { users } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Reads `app_user` — only what the audit trail needs (E11.1). No writes: user
 * provisioning belongs to the auth epic.
 *
 * The lookup is `lower(email) = lower($1)`: the seed writes lower-cased
 * addresses, but a Google session may hand over "Ten.Nguyen@Example.com", and a
 * case-sensitive miss would silently drop the actor from the audit row.
 */
export class DrizzleUserRepo implements UserRepo {
  constructor(private readonly db: Database) {}

  async findUserIdByEmail(tenantId: TenantId, email: string): Promise<string | null> {
    const scope = forTenant(this.db, tenantId);
    const normalised = typeof email === "string" ? email.trim().toLowerCase() : "";
    // Guard: an empty e-mail must not run a query that matches "whoever has ''".
    if (normalised.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findUserIdByEmail requires an e-mail",
        userMessage: "Thiếu email người thực hiện.",
        context: { tenant_id: scope.tenantId, field: "email" },
      });
    }

    try {
      const rows = await scope.db
        .select({ id: users.id })
        .from(users)
        .where(scope.where(users, eq(sql`lower(${users.email})`, normalised)))
        .limit(1);
      return rows[0]?.id ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "user.findUserIdByEmail",
        tenant_id: scope.tenantId,
        field: "email",
      });
    }
  }

  /**
   * `UNIQUE (tenant_id, account_id)` makes this at most one row, so there is no
   * ordering question and `limit(1)` is a formality, not a tie-break.
   *
   * `isNotNull` is not needed: an equality on a NULL column never matches, so a
   * backfill leftover with `account_id IS NULL` simply is not found — which is
   * the honest answer, and the caller turns it into "no server-side draft".
   */
  async findUserIdByAccount(tenantId: TenantId, accountId: string): Promise<string | null> {
    const scope = forTenant(this.db, tenantId);
    const normalised = typeof accountId === "string" ? accountId.trim() : "";
    // Guard: an empty account id must not run a query at all — Postgres would
    // reject it as a bad uuid literal and the driver error would read as an
    // outage rather than as the caller's mistake.
    if (normalised.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findUserIdByAccount requires an account id",
        userMessage: "Thiếu mã tài khoản người thực hiện.",
        context: { tenant_id: scope.tenantId, field: "accountId" },
      });
    }

    try {
      const rows = await scope.db
        .select({ id: users.id })
        .from(users)
        .where(scope.where(users, eq(users.accountId, normalised)))
        .limit(1);
      return rows[0]?.id ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "user.findUserIdByAccount",
        tenant_id: scope.tenantId,
        field: "accountId",
      });
    }
  }
}
