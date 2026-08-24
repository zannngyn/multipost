import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { PostsHub } from "@/ui/components/posts/PostsHub";
import { parsePostsTab, type PostsTab } from "@/ui/components/posts/posts-tabs";
import { ScheduledSkeleton } from "@/ui/components/scheduled/ScheduledSkeleton";

/**
 * "Bài đăng" (wave-1 IA): the hub that replaced `/scheduled` and `/jobs`.
 * Server Component guard, client hub.
 *
 * Both child screens read their filter — and the scheduled one its two dialogs
 * — from the query string, so the hub must sit under a <Suspense> boundary:
 * `useSearchParams()` suspends until the request's search params are known.
 */

export const metadata: Metadata = {
  title: "Bài đăng — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function PostsPage(props: PageProps<"/posts">) {
  const session = await getOperatorSession("page:/posts");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fposts");

  // Parsed here as well as in the hub so the fallback below can show the
  // skeleton of the tab that is actually opening — a hand-edited `?tab=` never
  // reaches a child screen.
  const tab = parsePostsTab((await props.searchParams).tab);

  return (
    // No container here: the hub owns its own frame (Layout + full-width header
    // band), same split as `/channels`, `/members` and `/bulk`. A wrapper would
    // sit INSIDE that frame and bound the header band as well.
    <Suspense fallback={<PostsFallback tab={tab} />}>
      <PostsHub tab={tab} />
    </Suspense>
  );
}

/**
 * Hub header + tab strip + the opening tab's own header, filter bar and list —
 * the same column and the same heights as the real thing, so nothing moves when
 * data lands (web-feedback-states rule 1). `aria-hidden`: grey boxes are not
 * content.
 */
function PostsFallback({ tab }: { tab: PostsTab }) {
  return (
    <div aria-hidden="true" className="motion-safe:animate-pulse">
      {/* The header band: full-width divider, bounded column inside — the two
          boxes `PostsHub`'s LayoutHeader draws. */}
      <div className="border-border border-b">
        <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-4">
          <div className="space-y-2">
            <div className="bg-muted h-8 w-40 rounded" />
            <div className="bg-muted h-4 w-full max-w-md rounded" />
          </div>
          <div className="flex gap-2">
            <div className="bg-muted h-8 w-28 rounded-lg" />
            <div className="bg-muted h-8 w-32 rounded-lg" />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
        <div className="space-y-2">
          <div className="bg-muted h-8 w-48 rounded" />
          <div className="bg-muted h-4 w-full max-w-xl rounded" />
        </div>

        {tab === "scheduled" ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="bg-muted h-9 w-64 rounded-lg" />
              <div className="bg-muted h-9 w-44 rounded-lg" />
              <div className="bg-muted h-9 w-44 rounded-lg" />
            </div>
            <ScheduledSkeleton />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="bg-muted h-9 w-64 rounded-lg" />
              <div className="bg-muted h-8 w-24 rounded-lg" />
            </div>
            <JobLogSkeleton />
          </>
        )}
      </div>
    </div>
  );
}
