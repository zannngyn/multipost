import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { setPasswordAction } from "@/app/(app)/members/_actions";
import { canManageAccess } from "@/app/_auth/operator-session";
import { getOperatorSession } from "@/app/_auth/session";
import { MembersFallback } from "@/ui/components/members/MembersFallback";
import { MembersHub } from "@/ui/components/members/MembersHub";
import { parseMembersTab } from "@/ui/components/members/members-tabs";

/**
 * "Thành viên" (M2.3 + wave-1 IA): the hub that absorbed the invite block and
 * `/access`. Server Component guard, client hub.
 *
 * The hub owns its own frame (Layout + header), so this page adds no container.
 *
 * It reads `?tab=` — and the history panel its `?status=` filter — from the
 * query string, so it must sit under a <Suspense> boundary:
 * `useSearchParams()` suspends until the request's search params are known.
 *
 * TWO gates, on purpose:
 *   - session: nobody unauthenticated renders anything;
 *   - `canManageAccess`: the same rule that guarded `/access` and still guards
 *     `GET /api/access-requests`. Decided here, on the server, and handed to
 *     the hub — the history tab is reached by a client-side rewrite, so the
 *     guard has to travel with the component instead of living in a route.
 *
 * The membership ROLE gate stays inside the panels: an editor may look at the
 * list and see who to ask, they simply cannot change anything — and the server
 * refuses those writes regardless (doc 10 §2, tier S).
 */

export const metadata: Metadata = {
  title: "Thành viên — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function MembersPage(props: PageProps<"/members">) {
  const session = await getOperatorSession("page:/members");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fmembers");

  // Parsed here as well as in the hub so the fallback below can show the
  // skeleton of the tab that is actually opening — a hand-edited `?tab=` never
  // reaches a panel.
  const tab = parseMembersTab((await props.searchParams).tab);

  return (
    <Suspense fallback={<MembersFallback tab={tab} />}>
      <MembersHub
        tab={tab}
        canViewHistory={canManageAccess(session)}
        operatorEmail={session.email}
        /* The Server Action travels as a prop: `ui/` may not import `@/app/*`,
           and the action re-checks the session and the platform standing on
           every call, so handing it over costs no authority. */
        resetPassword={setPasswordAction}
      />
    </Suspense>
  );
}
