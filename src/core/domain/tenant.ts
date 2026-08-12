/**
 * Tenant — the root of every multi-tenant rule (CLAUDE.md business rule 7).
 * Pure TypeScript: no imports, no I/O (see docs/07 section 2).
 */

export const TENANT_STATUSES = ["active", "suspended"] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
}

/**
 * Loose UUID shape: 8-4-4-4-12 hex.
 * Deliberately NOT the RFC-4122 version/variant regex — fixture ids such as
 * 00000000-0000-0000-0000-000000000001 (seed demo tenant) are valid Postgres
 * uuid values but carry no version nibble.
 */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

export function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === "string" && (TENANT_STATUSES as readonly string[]).includes(value);
}
