import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { canManageAccess } from "@/app/_auth/operator-session";
import { getOperatorSession } from "@/app/_auth/session";
import { AccessFallback } from "@/ui/components/access/AccessFallback";
import { AccessForbidden } from "@/ui/components/access/AccessForbidden";
import { AccessRequestsScreen } from "@/ui/components/access/AccessRequestsScreen";

/**
 * "Quyền truy cập" (E10). Server Component guard, client screen: the session is
 * resolved before anything renders, so no private markup can leak and there is
 * no "unknown" flash.
 *
 * The screen owns its own frame (Layout + header), so this page adds no
 * container of its own.
 *
 * It reads the status filter from the query string, so it must sit under a
 * <Suspense> boundary — `useSearchParams()` suspends until the request's search
 * params are known.
 */

export const metadata: Metadata = {
  title: "Quyền truy cập — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const session = await getOperatorSession("page:/access");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Faccess");

  // Checked BEFORE any row renders, not after the API says 403: the same rule
  // guards `/api/access-requests` (app/api/access-requests/_lib/admin-guard),
  // and an operator must never be shown buttons that are going to be refused.
  if (!canManageAccess(session)) return <AccessForbidden email={session.email} />;

  return (
    <Suspense fallback={<AccessFallback />}>
      <AccessRequestsScreen />
    </Suspense>
  );
}
