import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { JobLogScreen } from "@/ui/components/jobs/JobLogScreen";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { AppNav } from "@/ui/components/nav/AppNav";

/**
 * "Nhật ký đăng bài" (E11.1). Server Component guard, client screen.
 *
 * The screen reads its filter from the query string, so it must sit under a
 * <Suspense> boundary — `useSearchParams()` suspends until the request's search
 * params are known.
 */

export const metadata: Metadata = {
  title: "Nhật ký đăng bài — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const session = await getOperatorSession("page:/jobs");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fjobs");

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <Suspense fallback={<JobsFallback />}>
          <JobLogScreen />
        </Suspense>
      </main>
    </>
  );
}

/** Same header + filter bar + table heights as the real screen (CLS = 0). */
function JobsFallback() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="space-y-2">
        <div className="bg-muted h-8 w-56 rounded" />
        <div className="bg-muted h-4 w-full max-w-xl rounded" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="bg-muted h-9 w-64 rounded-lg" />
        <div className="bg-muted h-8 w-24 rounded-lg" />
      </div>
      <JobLogSkeleton />
    </div>
  );
}
