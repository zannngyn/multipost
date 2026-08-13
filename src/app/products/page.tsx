import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { AppNav } from "@/ui/components/nav/AppNav";
import { ProductListScreen } from "@/ui/components/products/ProductListScreen";
import { ProductTableSkeleton } from "@/ui/components/products/ProductTableSkeleton";

/**
 * "Sản phẩm" (E10). Server Component guard, client screen.
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
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <Suspense fallback={<ProductsFallback />}>
          <ProductListScreen />
        </Suspense>
      </main>
    </>
  );
}

/** Same header + totals + search + table heights as the real screen (CLS = 0). */
function ProductsFallback() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="space-y-2">
        <div className="bg-muted h-8 w-40 rounded" />
        <div className="bg-muted h-4 w-full max-w-xl rounded" />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((cell) => (
          <div key={cell} className="bg-muted h-24 rounded-xl" />
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="bg-muted h-9 w-80 rounded-lg" />
        <div className="bg-muted h-8 w-24 rounded-lg" />
      </div>
      <ProductTableSkeleton />
    </div>
  );
}
