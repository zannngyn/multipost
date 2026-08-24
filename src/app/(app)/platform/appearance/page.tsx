import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { AppearanceScreen } from "@/ui/components/platform/AppearanceScreen";
import { PlatformForbidden } from "@/ui/components/platform/PlatformForbidden";

/**
 * "Màu giao diện" (M3.4) — MYSP's own appearance setting.
 *
 * Guarded the same three ways as `/platform`:
 *  1. here, before any markup renders, on `session.platformRole`;
 *  2. by the API, which re-checks the role on every call and demands
 *     `super_admin` for the write;
 *  3. by the nav, which does not show the section at all — courtesy, never
 *     protection.
 *
 * Inside `(app)` for the shell, outside the tenant context: a platform admin
 * may hold no membership anywhere, so `TenantBoundary` has to let this path
 * through like it does `/platform` (see `isTenantIndependentPath`).
 */

export const metadata: Metadata = {
  title: "Màu giao diện — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function PlatformAppearancePage() {
  const session = await getOperatorSession("page:/platform/appearance");

  if (!session) redirect("/signin?returnUrl=%2Fplatform%2Fappearance");

  // `support` reads which colour is on; `super_admin` changes it. Which of the
  // two decides what the screen offers, not whether it opens.
  if (session.platformRole === null) return <PlatformForbidden email={session.email} />;

  return <AppearanceScreen />;
}
