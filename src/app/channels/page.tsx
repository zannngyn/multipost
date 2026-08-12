import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { ChannelGroupsScreen } from "@/ui/components/channels/ChannelGroupsScreen";
import { AppNav } from "@/ui/components/nav/AppNav";

/**
 * "Nhóm kênh" (E7.6 / E10.3). Server Component guard, client screen.
 */

export const metadata: Metadata = {
  title: "Nhóm kênh — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const session = await getOperatorSession("page:/channels");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fchannels");

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <ChannelGroupsScreen />
      </main>
    </>
  );
}
