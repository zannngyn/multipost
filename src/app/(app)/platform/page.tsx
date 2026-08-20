import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { PlatformForbidden } from "@/ui/components/platform/PlatformForbidden";
import { PlatformScreen } from "@/ui/components/platform/PlatformScreen";

/**
 * "Công ty khách" (M3.2) — MYSP's own admin screen.
 *
 * Guarded THREE times, on purpose:
 *  1. here, before any markup renders, on `session.platformRole`;
 *  2. by the API, which re-checks the role on every call (doc 10 §2);
 *  3. by the nav, which does not show the section at all — courtesy, never
 *     protection, because "ẩn khỏi menu nhưng gõ thẳng URL vẫn vào được" is
 *     exactly the hole guard 1 closes.
 *
 * It lives inside `(app)` for its shell, but NOT inside the tenant context:
 * a platform admin may hold no membership anywhere, so `TenantBoundary` lets
 * this path through (see `isTenantIndependentPath`).
 */

export const metadata: Metadata = {
  title: "Công ty khách — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function PlatformPage() {
  const session = await getOperatorSession("page:/platform");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fplatform");

  // `support` and `super_admin` both read this screen; which of the two decides
  // what the screen offers, not whether it opens.
  if (session.platformRole === null) return <PlatformForbidden email={session.email} />;

  return <PlatformScreen />;
}
