import { handleSetTenantStatus } from "../_lib/set-status";

/**
 * M3.2 — `POST /api/platform/tenants/[tenantId]/activate` (super_admin, S).
 * The inverse switch; activating a tenant that was never suspended is a clean
 * idempotent no-op (`already: true`).
 */

const ROUTE = "POST /api/platform/tenants/[tenantId]/activate";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<Response> {
  return handleSetTenantStatus(request, params, { route: ROUTE, status: "active" });
}
