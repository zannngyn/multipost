import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { JoinInviteScreen } from "@/ui/components/tenant/JoinInviteScreen";

/**
 * `/join/<token>` — accepting an invite (M2.2 client half).
 *
 * WHY IT SITS OUTSIDE `(app)`, not inside it:
 *  - the person following this link is by definition not in a company yet, and
 *    `(app)/layout` wraps everything in `TenantBoundary`, which would answer
 *    their NoMembership state with the onboarding screen — i.e. the invite page
 *    would never render for exactly the person it exists for;
 *  - the shell's nav (Sản phẩm, Đồng bộ, Nhật ký…) points at screens that need
 *    a company. Offering them here is offering dead ends.
 *
 * It is still GUARDED: `/join` is not in `PUBLIC_PREFIXES`, so an anonymous
 * visitor is redirected by the middleware to
 * `/signin?returnUrl=/join/<token>` — `safeReturnUrl` accepts it (a same-origin
 * path), so signing in lands them back on this exact invite instead of on the
 * home page with nothing to show for the click (core-auth-session §deep link).
 */

export const metadata: Metadata = {
  title: "Lời mời vào công ty — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const session = await getOperatorSession("page:/join");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard. The token
  // travels back in `returnUrl` so the invite survives the sign-in round trip.
  if (!session) {
    redirect(`/signin?returnUrl=${encodeURIComponent(`/join/${token}`)}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
      <JoinInviteScreen token={token} />
    </main>
  );
}
