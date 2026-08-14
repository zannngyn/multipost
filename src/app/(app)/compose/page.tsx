import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ComposeWizard } from "@/ui/components/compose/ComposeWizard";

/**
 * "Soạn bài" wizard (E3 + E4). Server Component guard, client wizard.
 *
 * The wizard reads its step from the query string, so it must sit under a
 * <Suspense> boundary — `useSearchParams()` suspends until the request's search
 * params are known.
 */

export const metadata: Metadata = {
  title: "Soạn bài — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const session = await getOperatorSession("page:/compose");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fcompose");

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <Suspense fallback={<ComposeWizardFallback />}>
        <ComposeWizard />
      </Suspense>
    </div>
  );
}

/** Matches the wizard header + stepper heights so nothing jumps (CLS = 0). */
function ComposeWizardFallback() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="space-y-2">
        <div className="bg-muted h-8 w-40 rounded" />
        <div className="bg-muted h-4 w-full max-w-xl rounded" />
      </div>
      <div className="flex gap-2">
        {[0, 1, 2].map((step) => (
          <div key={step} className="bg-muted h-9 w-40 rounded-lg" />
        ))}
      </div>
      <div className="bg-muted h-6 w-56 rounded" />
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2].map((field) => (
          <div key={field} className="space-y-2">
            <div className="bg-muted h-4 w-32 rounded" />
            <div className="bg-muted h-9 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
