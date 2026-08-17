import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { ChannelGroupsScreen } from "@/ui/components/channels/ChannelGroupsScreen";

/**
 * "Nhóm kênh" (E7.6 / E10.3). Server Component guard, client screen.
 *
 * Moved under /channels in E5.1: /channels now lists the connected Pages, and a
 * group is a shortcut built ON TOP of that list — the nesting says so.
 */

export const metadata: Metadata = {
  title: "Nhóm kênh — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ChannelGroupsPage() {
  const session = await getOperatorSession("page:/channels/groups");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fchannels%2Fgroups");

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <ChannelGroupsScreen />
    </div>
  );
}
