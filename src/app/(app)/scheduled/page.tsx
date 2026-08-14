import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ScheduledScreen } from "@/ui/components/scheduled/ScheduledScreen";
import { ScheduledSkeleton } from "@/ui/components/scheduled/ScheduledSkeleton";

/**
 * "Bài đã hẹn" (E8.4). Server Component guard, client screen.
 *
 * The screen reads its filter AND its two dialogs from the query string, so it
 * must sit under a <Suspense> boundary — `useSearchParams()` suspends until the
 * request's search params are known.
 */

export const metadata: Metadata = {
  title: "Bài đã hẹn — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ScheduledPage() {
  const session = await getOperatorSession("page:/scheduled");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fscheduled");

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <Suspense fallback={<ScheduledFallback />}>
        <ScheduledScreen />
      </Suspense>
    </div>
  );
}

/** Same header + filter bar + list heights as the real screen (CLS = 0). */
function ScheduledFallback() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="space-y-2">
        <div className="bg-muted h-8 w-48 rounded" />
        <div className="bg-muted h-4 w-full max-w-xl rounded" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="bg-muted h-9 w-64 rounded-lg" />
        <div className="bg-muted h-9 w-44 rounded-lg" />
        <div className="bg-muted h-9 w-44 rounded-lg" />
      </div>
      <ScheduledSkeleton />
    </div>
  );
}
