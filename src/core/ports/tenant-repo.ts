import type { Tenant } from "@/core/domain/tenant";

/**
 * Tenant persistence port. Core declares the need; adapters/db implements it.
 *
 * Contract for implementers:
 * - `findById` returns null for "no such tenant" — absence is not an error.
 * - Any driver/transport failure MUST surface as AppError('DB_ERROR') carrying
 *   `tenant_id` in its context; never leak a driver-specific error upward.
 * - The round-trip doubles as the datastore liveness check, so there is no
 *   separate `health()` here (no dead port surface).
 */
export interface TenantRepo {
  findById(tenantId: string): Promise<Tenant | null>;
}
