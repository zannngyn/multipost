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

  // Full-bleed: the wizard owns its own rail, scroll region and action bar, so
  // it takes the whole content area of the shell rather than sitting in a
  // centred column (docs/07 §4.1 + core-layout-shell §fixed shell).
  return (
    <div className="h-full min-h-0">
      <Suspense fallback={<ComposeWizardFallback />}>
        <ComposeWizard />
      </Suspense>
    </div>
  );
}

/** Same three regions at the same sizes as the wizard, so nothing jumps (CLS = 0). */
function ComposeWizardFallback() {
  return (
    <div aria-hidden="true" className="flex h-full min-h-0 flex-col motion-safe:animate-pulse lg:flex-row">
      <div className="bg-card border-border flex shrink-0 flex-col gap-1.5 border-b px-5 py-6 lg:w-75 lg:border-r lg:border-b-0">
        {[0, 1, 2].map((step) => (
          <div key={step} className="bg-muted h-16 rounded-xl" />
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 px-6 pt-7 lg:px-8">
          <div className="bg-muted h-9 w-56 rounded" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((field) => (
              <div key={field} className="bg-muted h-28 rounded-xl" />
            ))}
          </div>
          <div className="bg-muted h-48 rounded-xl" />
        </div>
        <div className="bg-card border-border shrink-0 border-t lg:h-18" />
      </div>
    </div>
  );
}
