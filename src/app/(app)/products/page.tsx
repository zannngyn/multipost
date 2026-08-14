import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { ProductListScreen } from "@/ui/components/products/ProductListScreen";
import { ProductsFallback } from "@/ui/components/products/ProductsFallback";

/**
 * "Sản phẩm" (E10). Server Component guard, client screen.
 *
 * The screen owns its own frame (Layout + inspector panel), so this page adds
 * no container of its own — a max-width wrapper here would fight the panel.
 *
 * The screen reads its filter from the query string, so it must sit under a
 * <Suspense> boundary — `useSearchParams()` suspends until the request's search
 * params are known.
 */

export const metadata: Metadata = {
  title: "Sản phẩm — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const session = await getOperatorSession("page:/products");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fproducts");

  return (
    <Suspense fallback={<ProductsFallback />}>
      <ProductListScreen />
    </Suspense>
  );
}
