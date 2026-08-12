import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { BulkRunScreen } from "@/ui/components/bulk/BulkRunScreen";
import { AppNav } from "@/ui/components/nav/AppNav";

/**
 * "Chạy hàng loạt" (E10.5). Server Component guard, client screen.
 */

export const metadata: Metadata = {
  title: "Chạy hàng loạt — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function BulkPage() {
  const session = await getOperatorSession("page:/bulk");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fbulk");

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <BulkRunScreen />
      </main>
    </>
  );
}
