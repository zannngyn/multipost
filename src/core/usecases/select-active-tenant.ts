import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { AccountRepo } from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * M1.2 — `POST /api/me/active-tenant`. Tier S by contract (doc 10 §4.4): the
 * membership is read FRESH, never from a cache — a cookie pointing at a company
 * the person was just removed from must be refused now, not in 60 seconds.
 *
 * Every refusal is the SAME 404 TENANT_NOT_FOUND: no membership, removed
 * membership, suspended tenant and non-existent tenant are indistinguishable to
 * the caller, so the endpoint cannot be used to probe which tenants exist
 * (doc 10 §3 — resources without membership behave as absent).
 */

export interface SelectActiveTenantInput {
  readonly sessionEmail: string;
  readonly tenantId: TenantId;
}

export interface SelectActiveTenantResult {
  readonly activeTenantId: string;
}

export interface SelectActiveTenantDeps {
  accounts: AccountRepo;
  logger: Logger;
}

export type SelectActiveTenant = (
  input: SelectActiveTenantInput,
) => Promise<SelectActiveTenantResult>;

export function makeSelectActiveTenant(deps: SelectActiveTenantDeps): SelectActiveTenant {
  return async function selectActiveTenant(input) {
    // --- Edge cases first ---------------------------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "selectActiveTenant requires a UUID tenant id",
        userMessage: "Mã công ty không hợp lệ.",
        context: { field: "tenantId" },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const sessionEmail =
      typeof input?.sessionEmail === "string" ? input.sessionEmail.trim().toLowerCase() : "";
    if (sessionEmail.length === 0) {
      throw new AppError("UNAUTHORIZED", {
        message: "selectActiveTenant requires a signed-in operator",
      });
    }

    const notFound = () =>
      new AppError("TENANT_NOT_FOUND", {
        message: "Account has no active membership in the requested tenant",
        userMessage: "Không tìm thấy công ty tương ứng.",
        context: { tenant_id: tenantId },
      });

    const summary = await deps.accounts.findAccountBySessionEmail(sessionEmail);
    if (!summary || summary.status !== "active") throw notFound();

    // FRESH read on purpose — tier S (see the module header).
    const membership = await deps.accounts.findMembership(summary.accountId, tenantId);
    if (!membership || membership.status !== "active" || membership.tenantStatus !== "active") {
      deps.logger.warn("Active-tenant switch refused", {
        tenant_id: tenantId,
        account_id: summary.accountId,
        error_code: "TENANT_NOT_FOUND",
        membership_found: membership !== null,
      });
      throw notFound();
    }

    deps.logger.info("Active tenant switched", {
      tenant_id: tenantId,
      account_id: summary.accountId,
      membership_role: membership.role,
    });

    return { activeTenantId: tenantId };
  };
}
