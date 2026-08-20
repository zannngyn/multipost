import { sql } from "drizzle-orm";

import type { DbExecutor } from "./client";
import type { TenantScopedDb } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Serialises the read-modify-write of ONE `tenant_integration` row.
 *
 * Every writer of that table reads the jsonb `config`, merges into it, and
 * upserts. `SELECT ... FOR UPDATE` is not enough on its own: the FIRST write of
 * a (tenant, provider) pair has no row to lock, so two callers both read an
 * empty config and the second `ON CONFLICT DO UPDATE` overwrites the first
 * one's data — with both requests reporting success. That is the shape of the
 * bug for the meta row (Pages lost on the first connect) and for the google row
 * (a source save lost, plus an audit row claiming a change that never happened).
 *
 * `pg_advisory_xact_lock` locks the PAIR itself, row or no row, and Postgres
 * releases it when the transaction ends — nothing to unlock by hand, nothing
 * left held by a crashed process. It must be taken INSIDE the transaction and
 * BEFORE the read.
 */

/** The lock key. Exported so a test can hold the very same lock. */
export function integrationLockKey(tenantId: TenantId, provider: string): string {
  return `tenant_integration:${tenantId}:${provider}`;
}

/**
 * Takes the lock for `(txScope.tenantId, provider)`. Call it first inside the
 * transaction; every other writer of that row then queues behind it.
 */
export async function lockIntegrationRow(
  txScope: TenantScopedDb<DbExecutor>,
  provider: string,
): Promise<void> {
  // hashtext -> int4, widened to the bigint pg_advisory_xact_lock takes. A hash
  // collision between two tenants costs one waiting write, nothing more.
  await txScope.db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${integrationLockKey(txScope.tenantId, provider)}))`,
  );
}
