import { z } from "zod";

/**
 * Contract of the tenant health endpoint, plus the shared error envelope.
 *
 * NOTE: `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so
 * these mirror the domain instead of reusing it. Any change to
 * `core/domain/tenant.ts` must be reflected here.
 *
 * M1.4 removed the tenant FORM that used to live here (and the hardcoded demo
 * id it was prefilled with): nobody types a company id any more — the session
 * decides which company a request belongs to, and `/api/me` tells the UI which
 * one that is.
 */

/**
 * Loose UUID shape — mirrors `isTenantId` in core/domain/tenant.ts. Deliberately
 * NOT `z.uuid()`: the seeded demo id has no RFC-4122 version nibble and would
 * be rejected. Still used to sanity-check the id that partitions the LOCAL
 * compose-draft buffer, never to authorise anything.
 */
export const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Response contract. External data is never trusted — parse before render. */
export const TenantHealthSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "suspended"]),
  checkedAt: z.iso.datetime(),
});

export type TenantHealth = z.infer<typeof TenantHealthSchema>;

/** Error envelope produced by app/api/_lib/http-errors.ts. */
export const ApiErrorBodySchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
