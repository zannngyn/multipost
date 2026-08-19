import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * TODO(M1.3b): DELETE THIS FILE. Every remaining caller is exactly the list of
 * routes that still trust a client-supplied tenant id (docs/11 §3) — when the
 * last one moves to `requireTenant()`, this function loses its callers and the
 * file goes with them. Do not add capabilities here; do not call it from new
 * code.
 *
 * M1.3a transition shim: turns the tenant string a route pulled out of a
 * request into a branded `TenantId` WITHOUT any membership check — i.e. it
 * preserves today's (B-8-vulnerable) behaviour, just visibly and greppably.
 */
export function legacyTenantIdFromRequest(value: unknown): TenantId {
  const tenantId = typeof value === "string" ? value.trim() : "";
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: "legacyTenantIdFromRequest requires a UUID tenant id",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { field: "tenantId" },
    });
  }
  // Blessed cast site (see core/domain/tenant-context.ts) — legacy, unchecked.
  return tenantId as TenantId;
}
