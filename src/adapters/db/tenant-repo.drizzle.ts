import { AppError } from "@/core/domain/errors";
import { isTenantStatus, type Tenant } from "@/core/domain/tenant";
import type { TenantRepo } from "@/core/ports/tenant-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { tenants } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/** Row -> domain. The DB enum can drift from the domain union across migrations. */
function toDomain(row: { id: string; name: string; status: string }): Tenant {
  if (!isTenantStatus(row.status)) {
    throw new AppError("DB_ERROR", {
      message: `Unknown tenant status '${row.status}' returned by the database`,
      userMessage: "Dữ liệu đơn vị (tenant) không hợp lệ. Vui lòng liên hệ quản trị viên.",
      context: { tenant_id: row.id, status: row.status },
    });
  }
  return { id: row.id, name: row.name, status: row.status };
}

export class DrizzleTenantRepo implements TenantRepo {
  constructor(private readonly db: Database) {}

  async findById(tenantId: TenantId): Promise<Tenant | null> {
    // Throws INVALID_INPUT on a malformed id before any SQL is built.
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ id: string; name: string; status: string }>;
    try {
      rows = await scope.db
        .select({ id: tenants.id, name: tenants.name, status: tenants.status })
        .from(tenants)
        .where(scope.whereSelf())
        .limit(1);
    } catch (error) {
      // Driver errors (connection refused, timeout, syntax) become one code.
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "tenant.findById",
      });
    }

    const row = rows[0];
    return row ? toDomain(row) : null;
  }
}
