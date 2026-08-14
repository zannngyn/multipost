import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { SyncScreen } from "@/ui/components/sync/SyncScreen";

/**
 * "Đồng bộ dữ liệu" (E2). Server Component: the session is resolved before
 * anything renders, so no private markup can leak and there is no "unknown"
 * flash. Only the panel itself is a client component.
 */

export const metadata: Metadata = {
  title: "Đồng bộ dữ liệu — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const session = await getOperatorSession("page:/sync");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fsync");

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <SyncScreen />
    </div>
  );
}
