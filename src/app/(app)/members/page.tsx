import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { MembersScreen } from "@/ui/components/members/MembersScreen";

/**
 * "Thành viên" (M2.3). Server Component guard, client screen: the session is
 * resolved before anything renders, so no private markup can leak and there is
 * no "unknown" flash.
 *
 * No <Suspense> wrapper here (unlike /access or /sync): this screen reads no
 * search params, so nothing suspends on the request's query string.
 *
 * The ROLE gate lives inside the screen rather than here: an editor may look at
 * the list and see who to ask, they simply cannot change anything — and the
 * server refuses the writes regardless (doc 10 §2, tier S).
 */

export const metadata: Metadata = {
  title: "Thành viên — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const session = await getOperatorSession("page:/members");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fmembers");

  return <MembersScreen />;
}
