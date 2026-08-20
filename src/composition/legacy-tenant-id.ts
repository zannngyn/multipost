import type { TenantId } from "@/core/domain/tenant-context";

/**
 * TODO(M1.3b): DELETE THIS FILE. Every remaining caller is exactly the list of
 * routes that still trust a client-supplied tenant id (docs/11 §3) — when the
 * last one moves to `requireTenant()`, this function loses its callers and the
 * file goes with them. Do not add capabilities here; do not call it from new
 * code.
 *
 * M1.3a transition shim: turns the tenant string a route pulled out of a request
 * (query, body or the OAuth state cookie) into a branded `TenantId` WITHOUT any
 * membership check AND without a shape check — i.e. it preserves today's
 * (B-8-vulnerable) behaviour EXACTLY, just visibly and greppably. Validation
 * stays where it already lived: the usecase (via `forTenant`), so a route that
 * used to hand an empty/garbage tenant to the usecase for it to refuse still
 * does (e.g. the OAuth callback with no state cookie).
 */
export function legacyTenantIdFromRequest(value: unknown): TenantId {
  const tenantId = typeof value === "string" ? value.trim() : "";
  // Blessed cast site (see core/domain/tenant-context.ts) — legacy, unchecked.
  return tenantId as TenantId;
}
