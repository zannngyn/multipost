import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { signOut } from "@/app/_auth/auth";
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

/**
 * The flow's own way out.
 *
 * This route sits outside `(app)`, so there is no `AppFrame` and no top bar to
 * sign out from — and slide 01 is reached precisely by accounts that belong to
 * no company, for whom every screen inside the app answers 409. Without this an
 * operator who signed in with the wrong account would be stuck in the browser.
 *
 * Declared here rather than imported from `(app)/layout.tsx`: a layout exports
 * only a component, and this is the same three-line action `/signin` also
 * declares locally.
 */
async function signOutOperator(): Promise<void> {
  "use server";
  // signOut() throws NEXT_REDIRECT — keep it out of try/catch.
  // NOTE (JWT stateless, see _auth/auth.config.ts): this clears the cookie in
  // THIS browser only. Other devices keep working until the token expires.
  await signOut({ redirectTo: "/signin" });
}

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
