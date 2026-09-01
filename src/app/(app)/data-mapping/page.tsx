import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { DataMappingFallback } from "@/ui/components/onboarding/DataMappingFallback";
import { DataMappingScreen } from "@/ui/components/onboarding/DataMappingScreen";

/**
 * "Kết nối dữ liệu" (E10, onboarding phase 1). Server Component guard, client
 * screen — the session is resolved before anything renders, so no private markup
 * can leak and there is no "unknown" flash.
 *
 * The screen reads its step from the query string (`?buoc=`), so it must sit
 * under a <Suspense> boundary — `useSearchParams()` suspends until the request's
 * search params are known.
 */

export const metadata: Metadata = {
  title: "Kết nối dữ liệu — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function DataMappingPage() {
  const session = await getOperatorSession("page:/data-mapping");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fdata-mapping");

  return (
    <Suspense fallback={<DataMappingFallback />}>
      <DataMappingScreen />
    </Suspense>
  );
}
