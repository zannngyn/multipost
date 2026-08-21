import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { BulkRunScreen } from "@/ui/components/bulk/BulkRunScreen";

/**
 * "Chạy hàng loạt" (E10.5). Server Component guard, client screen.
 *
 * The screen owns its own frame (Layout header + scrolling content), so this
 * page adds no container: a centred max-width wrapper here would squeeze the
 * per-code result rows, which are the whole point of the screen.
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

  return <BulkRunScreen />;
}
