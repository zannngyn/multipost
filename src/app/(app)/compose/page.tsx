import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ComposeFocus } from "@/ui/components/compose/ComposeFocus";
import { COMPOSE_PALETTE } from "@/ui/components/compose/compose-theme";

/**
 * "Soạn bài" (E3 + E4) — ONE screen, per the approved ComposeFocus design.
 * Server Component guard, client screen.
 *
 * It reads `?code=` (deep link from the product list) from the query string, so
 * it must sit under a <Suspense> boundary — `useSearchParams()` suspends until
 * the request's search params are known.
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

  // Full-bleed: the screen owns its own scroll region, palette and action bar,
  // so it takes the whole content area of the shell rather than sitting in a
  // centred column (docs/07 §4.1 + core-layout-shell §fixed shell).
  return (
    <div className="h-full min-h-0">
      <Suspense fallback={<ComposeFallback />}>
        <ComposeFocus />
      </Suspense>
    </div>
  );
}

/** The same two columns at the same sizes as the screen, so nothing jumps. */
function ComposeFallback() {
  return (
    <div
      aria-hidden="true"
      style={COMPOSE_PALETTE}
      className="h-full min-h-0 bg-[var(--background)] motion-safe:animate-pulse"
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-5">
        <div className="h-7 w-40 rounded bg-[var(--compose-track)]" />
        <div className="flex flex-col items-start gap-6 xl:flex-row">
          <div className="h-160 w-full rounded-[var(--compose-radius-card)] bg-[var(--card)] xl:w-190 xl:shrink-0" />
          <div className="h-140 w-full rounded-[var(--compose-radius-block)] bg-[var(--card)] xl:min-w-0 xl:flex-1" />
        </div>
      </div>
    </div>
  );
}
