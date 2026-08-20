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
}
