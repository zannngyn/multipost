import { z } from "zod";

/**
 * Schemas for the tenant health screen: one for the form the operator types in,
 * one for what the API is allowed to return. Both live here so the form and the
 * service agree by construction (web-data-fetching rule 7).
 *
 * NOTE: `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so
 * these mirror the domain instead of reusing it. Any change to
 * `core/domain/tenant.ts` must be reflected here.
 */

/**
 * Loose UUID shape — mirrors `isTenantId` in core/domain/tenant.ts. Deliberately
 * NOT `z.uuid()`: the seeded demo id has no RFC-4122 version nibble and would
 * be rejected.
 */
export const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seeded fixture (mirrors DEMO_TENANT_ID in adapters/db/seed.ts) — prefilled. */
export const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Reusable tenant id field. Every screen validates it the same way, so an
 * operator never sees two different sentences for the same mistake
 * (core-component-reuse: share the rule, not just the widget).
 */
export const tenantIdField = () =>
  z
    .string()
    .trim()
    .min(1, "Nhập mã đơn vị (tenant) để tiếp tục.")
    .regex(TENANT_ID_PATTERN, `Mã đơn vị phải có dạng UUID, ví dụ: ${DEMO_TENANT_ID}`);

export const TenantHealthFormSchema = z.object({
  tenantId: z
    .string()
    .trim()
    .min(1, "Nhập mã đơn vị (tenant) để kiểm tra.")
    .regex(TENANT_ID_PATTERN, "Mã đơn vị phải có dạng UUID, ví dụ: " + DEMO_TENANT_ID),
});

export type TenantHealthFormValues = z.infer<typeof TenantHealthFormSchema>;

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
