import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Third blessed `TenantId` constructor (docs/10 §5) — for actor=system, i.e. the
 * worker, which has no session and no membership check. The tenant of a system
 * action ALWAYS comes from a stored row (a validated job payload, `post_job`,
 * a credential claim), never from a request.
 *
 * `component` names the closed list of system sites (publish-post, reaper, ...)
 * so a system-branded tenant is greppable and, later (M1.1 audit), attributable.
 * Import is ESLint-restricted to worker composition (`paths` + `importNames`,
 * docs/10 §5): business/route code must never reach for this.
 */
export function systemTenantId(
  row: { readonly tenantId: string },
  meta: { readonly component: string },
): TenantId {
  // Guard first: a system row without a tenant is a wiring bug, not user input.
  // This mirrors today's behaviour (the payload schema already rejects empty),
  // it does not add UUID validation — the usecase still owns that domain rule.
  if (typeof row.tenantId !== "string" || row.tenantId.trim() === "") {
    throw new AppError("INVALID_INPUT", {
      message: "systemTenantId requires a non-empty tenantId from a stored row",
      context: { system_component: meta.component },
    });
  }
  // Blessed cast site (see core/domain/tenant-context.ts header).
  return row.tenantId as TenantId;
}
