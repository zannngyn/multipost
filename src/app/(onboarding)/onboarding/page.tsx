import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { signOutOperator } from "@/app/_auth/signout-action";
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

/**
 * The flow's own way out lives in `_auth/signout-action.ts` now — this route
 * sits outside `(app)`, so there is no `AppFrame` and no top bar to sign out
 * from, and slide 01 is reached precisely by accounts that belong to no
 * company. Two copies of the action meant the active-tenant selector had to be
 * cleared in two places, which is one place too many to get right.
 */

export default async function OnboardingPage() {
  const session = await getOperatorSession("page:/onboarding");

  // Defence in depth: the proxy already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fonboarding");

  return (
    <Suspense fallback={null}>
      {/* A dev fake session has no cookie to clear, so it gets no button —
          same withholding `(app)/layout.tsx` applies to the top bar. */}
      <OnboardingFlow signOutAction={session.isDevFake ? undefined : signOutOperator} />
    </Suspense>
  );
}
