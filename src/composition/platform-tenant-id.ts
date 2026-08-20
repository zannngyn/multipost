import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Fourth blessed `TenantId` constructor (docs/10 §3.5, the platform layer
 * anticipated by core/domain/tenant-context.ts). Platform APIs are the ONE
 * place a client-named target tenant is legitimate: a super_admin says which
 * customer they are acting on, `requirePlatformAdmin` has already authorised
 * the ACTOR, and the target either exists (acted on, audited) or answers 404.
 *
 * `component` names the closed list of platform sites so a platform-branded
 * tenant id stays greppable and attributable — same discipline as
 * `systemTenantId`. Never import this from business/route code outside
 * `/api/platform/**`; the M3.3 support-mode work extends the same list.
 */
export function platformTenantId(
  value: unknown,
  meta: { readonly component: string },
): TenantId {
  const tenantId = typeof value === "string" ? value.trim() : "";
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: "platformTenantId requires a UUID tenant id",
      userMessage: "Mã công ty không hợp lệ.",
      context: { platform_component: meta.component },
    });
  }
  // Blessed cast site (see core/domain/tenant-context.ts header).
  return tenantId as TenantId;
}
