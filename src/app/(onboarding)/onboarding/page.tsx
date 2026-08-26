import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { OnboardingFlow } from "@/ui/components/onboarding/flow/OnboardingFlow";

/**
 * Server Component, same shape as `/sync`: the session resolves before anything
 * renders, so there is no "unknown" flash and no private markup can leak.
 *
 * `<Suspense>` is required, not decorative — the flow reads `?step=` through
 * `useSearchParams()`, which suspends until the request's params are known.
 */

export const metadata: Metadata = {
  title: "Bắt đầu với MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getOperatorSession("page:/onboarding");

  // Defence in depth: the proxy already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fonboarding");

  return (
    <Suspense fallback={null}>
      <OnboardingFlow />
    </Suspense>
  );
}
