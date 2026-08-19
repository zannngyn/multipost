import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { SyncFallback } from "@/ui/components/sync/SyncFallback";
import { SyncScreen } from "@/ui/components/sync/SyncScreen";

/**
 * "Đồng bộ dữ liệu" (E2). Server Component: the session is resolved before
 * anything renders, so no private markup can leak and there is no "unknown"
 * flash. Only the panel itself is a client component.
 *
 * The screen reads the Google OAuth callback (`?google=…`) from the query
 * string, so it must sit under a <Suspense> boundary — `useSearchParams()`
 * suspends until the request's search params are known.
 */

export const metadata: Metadata = {
  title: "Đồng bộ dữ liệu — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const session = await getOperatorSession("page:/sync");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fsync");

  // Full-bleed: the screen owns its own sticky header, scroll region and right
  // rail, so it takes the whole content area of the shell rather than sitting in
  // a centred column (core-layout-shell §fixed shell).
  return (
    <div className="h-full min-h-0">
      <Suspense fallback={<SyncFallback />}>
        <SyncScreen />
      </Suspense>
    </div>
  );
}
