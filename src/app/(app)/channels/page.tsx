import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ChannelsFallback } from "@/ui/components/channels/ChannelsFallback";
import { ConnectedChannelsScreen } from "@/ui/components/channels/ConnectedChannelsScreen";

/**
 * "Kênh" (E5.1). Server Component guard, client screen.
 *
 * The screen owns its own frame (Layout + header), so this page adds no
 * container of its own.
 *
 * It reads the OAuth callback from the query string, so it must sit under a
 * <Suspense> boundary — `useSearchParams()` suspends until the request's search
 * params are known.
 */

export const metadata: Metadata = {
  title: "Kênh — MYSP",
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
    <Suspense fallback={<ChannelsFallback />}>
      <ConnectedChannelsScreen />
    </Suspense>
  );
}
