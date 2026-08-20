import { z } from "zod";

import { ACCESS_ROLE_LABELS, AccessRoleSchema } from "@/ui/schemas/access-request.schema";

/**
 * Contract of `GET /api/me` — the ONE source of truth for "who am I and which
 * company am I working in" (M1.4, doc 10 §4.4).
 *
 * Before this existed the browser told the server which tenant to use; now the
 * server tells the browser. Everything tenant-scoped in the UI — every query
 * key, every screen header — reads from here, so there is exactly one place a
 * company switch has to land.
 *
 * `ui/` may not import `core/` (docs/07 §2), so this mirrors `OperatorOverview`
 * instead of reusing it. It is external data: parsed before any component sees
 * it, because a silently half-parsed answer here would put an operator in the
 * wrong company.
 */

export const PLATFORM_ROLES = ["support", "super_admin"] as const;
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

/** Same vocabulary as the access screen — one list of roles, not two. */
export const MembershipRoleSchema = AccessRoleSchema;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export const MEMBERSHIP_ROLE_LABELS = ACCESS_ROLE_LABELS;

export const MeTenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Null while a company has no slug yet — cosmetic, never an identifier. */
  slug: z.string().nullable(),
  plan: z.string().min(1),
  role: MembershipRoleSchema,
});
export type MeTenant = z.infer<typeof MeTenantSchema>;

export const MeResponseSchema = z.object({
  /** Null for env-bootstrap / dev-bypass sessions that have no account row. */
  account: z
    .object({
      id: z.string().min(1),
      displayName: z.string().nullable(),
      platformRole: PlatformRoleSchema.nullable(),
    })
    .nullable(),
  tenants: z.array(MeTenantSchema),
  /**
   * Null means "chưa chọn" — either the account belongs to no company, or to
   * several and none is selected. Which of the two, the `tenants` list says.
   */
  activeTenantId: z.string().nullable(),
  /**
   * Named in AUTH_ALLOWED_DOMAINS / AUTH_FACEBOOK_ALLOWED_USER_IDS. Optional
   * with a safe default on purpose: the field is being added server-side in
   * parallel, and a server that predates it is not a broken server — the UI
   * must not lock everyone out over a field that is not there yet. A field that
   * IS present but not a boolean is still a contract break and fails loudly.
   */
  isBootstrapAdmin: z.boolean().default(false),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const SetActiveTenantResponseSchema = z.object({
  activeTenantId: z.string().min(1),
});
export type SetActiveTenantResponse = z.infer<typeof SetActiveTenantResponseSchema>;

/**
 * Query-key segment for everything tenant-scoped.
 *
 * Why a string and not `string | null`: the cache must stay partitioned per
 * company (switching company must never show the previous one's rows), and a
 * bootstrap/dev session that has no membership row still needs a bucket of its
 * own. `"bootstrap"` is not a tenant id and can never collide with one — tenant
 * ids are UUIDs.
 */
export const BOOTSTRAP_TENANT_KEY = "bootstrap";

export function tenantCacheKey(tenantId: string | null): string {
  return tenantId ?? BOOTSTRAP_TENANT_KEY;
}

/** "Gói Pro" — plan comes from the server as a free-form code. */
export function planLabel(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed.length === 0) return "Không rõ gói";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** What the operator is called in the top bar; never an empty label. */
export function accountDisplayName(me: MeResponse | undefined, fallback: string): string {
  const name = me?.account?.displayName?.trim() ?? "";
  return name.length > 0 ? name : fallback;
}
