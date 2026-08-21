import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ScheduledFallback } from "@/ui/components/scheduled/ScheduledFallback";
import { ScheduledScreen } from "@/ui/components/scheduled/ScheduledScreen";

/**
 * "Bài đã hẹn" (E8.4). Server Component guard, client screen.
 *
 * The screen owns its own frame (Layout + header), so this page adds no
 * container of its own.
 *
 * It reads its filter AND its two dialogs from the query string, so it must sit
 * under a <Suspense> boundary — `useSearchParams()` suspends until the request's
 * search params are known.
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
    <Suspense fallback={<ScheduledFallback />}>
      <ScheduledScreen />
    </Suspense>
  );
}
