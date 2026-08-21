import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ChannelsFallback } from "@/ui/components/channels/ChannelsFallback";
import { ChannelsHub } from "@/ui/components/channels/ChannelsHub";
import { parseChannelsTab } from "@/ui/components/channels/channels-tabs";

/**
 * "Kênh" (E5.1 + wave-1 IA): the hub that absorbed `/channels/groups`. Server
 * Component guard, client hub.
 *
 * The hub owns its own frame (Layout + header), so this page adds no container.
 *
 * It reads `?tab=` and the OAuth callback from the query string, so it must sit
 * under a <Suspense> boundary — `useSearchParams()` suspends until the
 * request's search params are known.
 */

export const metadata: Metadata = {
  title: "Kênh — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ChannelsPage(props: PageProps<"/channels">) {
  const session = await getOperatorSession("page:/channels");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fchannels");

  // Parsed here as well as in the hub so the fallback below can show the
  // skeleton of the tab that is actually opening — a hand-edited `?tab=` never
  // reaches a panel.
  const tab = parseChannelsTab((await props.searchParams).tab);

  return (
    <Suspense fallback={<ChannelsFallback tab={tab} />}>
      <ChannelsHub tab={tab} />
    </Suspense>
  );
}
