import { handleSetTenantStatus } from "../_lib/set-status";

/**
 * M3.2 — `POST /api/platform/tenants/[tenantId]/suspend` (super_admin, S).
 * Suspension bites everywhere: tier-S checks see the fresh row immediately,
 * the caches are dropped by the container wrapper, and the worker's
 * suspended-guard (M1.3b) stops publishes. Idempotent (`already: true`).
 */

const ROUTE = "POST /api/platform/tenants/[tenantId]/suspend";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<Response> {
  return handleSetTenantStatus(request, params, { route: ROUTE, status: "suspended" });
}
