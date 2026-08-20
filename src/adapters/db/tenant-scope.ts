import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

import type { Database, DbExecutor } from "./client";
import { tenants } from "./schema";

/**
 * Tenant isolation helper (CLAUDE.md business rule 7).
 *
 * Repositories take a `TenantScopedDb`, never a bare `Database`, so the tenant
 * filter cannot be forgotten: there is no way to build a WHERE clause here that
 * does not start with `tenant_id = $tenantId`.
 *
 * Usage:
 *   const scope = forTenant(db, tenantId);
 *   await scope.db.select().from(products).where(scope.where(products, eq(products.code, code)));
 *   await scope.db.insert(products).values(scope.row({ code, name }));
 */

/** Structural contract: only tables carrying tenant_id can be scoped. */
export type TenantScopedTable = { tenantId: PgColumn };

export interface TenantScopedDb<TDb extends DbExecutor = Database> {
  readonly tenantId: TenantId;
  /**
   * Raw drizzle handle (db or transaction). Every statement built with it MUST
   * take its predicate from `where`/`whereSelf` — the point of this wrapper.
   */
  readonly db: TDb;
  /** `tenant_id = $tenantId AND (...extra)`. Undefined conditions are dropped. */
  where(table: TenantScopedTable, ...extra: Array<SQL | undefined>): SQL;
  /**
   * Predicate for the `tenant` root table itself, which has no tenant_id column
   * (its `id` IS the discriminator). The single documented exception.
   */
  whereSelf(): SQL;
  /** Stamps tenant_id onto a row so inserts cannot omit it. */
  row<T extends Record<string, unknown>>(values: T): T & { tenantId: TenantId };
}

export function forTenant<TDb extends DbExecutor>(
  db: TDb,
  tenantId: TenantId,
): TenantScopedDb<TDb> {
  // Guard first: an empty/garbage tenant id must never reach a query, where it
  // would either error opaquely or (worse) match nothing and look like "no data".
  // The brand narrows callers to blessed sources, but a test (or the legacy shim)
  // can still route a malformed value here, so the runtime check stays.
  if (typeof tenantId !== "string" || !isTenantId(tenantId.trim())) {
    throw new AppError("INVALID_INPUT", {
      message: "tenantId must be a UUID to scope a query",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: typeof tenantId === "string" ? tenantId.trim() || null : null },
    });
  }
  const normalised = normalizeTenantId(tenantId);

  return {
    tenantId: normalised,
    db,
    where(table, ...extra) {
      const conditions = [eq(table.tenantId, normalised), ...extra.filter(Boolean)];
      // and() is typed `SQL | undefined` for the empty case; we always pass one.
      return (conditions.length === 1 ? conditions[0] : and(...conditions)) as SQL;
    },
    whereSelf() {
      return eq(tenants.id, normalised);
    },
    row(values) {
      return { ...values, tenantId: normalised };
    },
  };
}
