import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { BatchStatusScreen } from "@/ui/components/batch/BatchStatusScreen";
import { AppNav } from "@/ui/components/nav/AppNav";

/**
 * "Theo dõi lô đăng" (E7.5). The batch is a server resource with its own URL
 * (web-long-running-jobs rule 1): shareable, bookmarkable, and correct when
 * opened from another machine.
 *
 * Server Component guard, client screen — the session is resolved before
 * anything renders, so no private markup can leak.
 */

export const metadata: Metadata = {
  title: "Theo dõi lô đăng — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const session = await getOperatorSession(`page:/batches/${batchId}`);

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) {
    redirect(`/signin?returnUrl=${encodeURIComponent(`/batches/${batchId}`)}`);
  }

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <BatchStatusScreen batchId={batchId} />
      </main>
    </>
  );
}
