import { AppError } from "@/core/domain/errors";
import { isTenantId, type TenantStatus } from "@/core/domain/tenant";
import type { TenantRepo } from "@/core/ports/tenant-repo";
import type { Clock, Logger } from "@/core/ports/infra";

/**
 * Walking-skeleton usecase: proves the wiring app -> composition -> adapters/db
 * -> core is alive for one tenant. Follows the port/usecase shape of docs/07 §3.2.
 */

export interface HealthcheckTenantInput {
  tenantId: string;
}

export interface HealthcheckTenantResult {
  tenantId: string;
  name: string;
  status: TenantStatus;
  /** ISO-8601, from the injected Clock — core never calls `new Date()`. */
  checkedAt: string;
}

export interface HealthcheckTenantDeps {
  tenants: TenantRepo;
  clock: Clock;
  logger: Logger;
}

export function makeHealthcheckTenant(deps: HealthcheckTenantDeps) {
  return async function healthcheckTenant(
    input: HealthcheckTenantInput,
  ): Promise<HealthcheckTenantResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ----------------------
    const rawTenantId: unknown = input?.tenantId;
    const tenantId = typeof rawTenantId === "string" ? rawTenantId.trim() : "";

    if (!isTenantId(tenantId)) {
      // No logger.child here: there is no trustworthy tenant_id to bind yet.
      deps.logger.warn("Tenant healthcheck rejected: malformed tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "tenantId must be a UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: tenantId || null },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId });

    // Repo failures are already AppError('DB_ERROR') from the adapter — let them
    // propagate untouched; catching here would only blur the cause.
    const tenant = await deps.tenants.findById(tenantId);

    if (!tenant) {
      log.warn("Tenant healthcheck failed: tenant not found", {
        error_code: "TENANT_NOT_FOUND",
      });
      throw new AppError("TENANT_NOT_FOUND", { context: { tenant_id: tenantId } });
    }

    // --- Happy path ---------------------------------------------------------
    const checkedAt = deps.clock.now().toISOString();
    log.info("Tenant healthcheck ok", { tenant_status: tenant.status, checked_at: checkedAt });

    return { tenantId: tenant.id, name: tenant.name, status: tenant.status, checkedAt };
  };
}

export type HealthcheckTenant = ReturnType<typeof makeHealthcheckTenant>;
