import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { OverviewScreen } from "@/ui/components/overview/OverviewScreen";

/**
 * Protected home. Server Component: the session is resolved before anything
 * renders, so there is no "unknown" flash and no private markup can leak
 * (core-auth-session: three session states).
 *
 * The operator identity and the sign-out action live in the shell's top bar,
 * under the account avatar, so this page is content only — and the screen owns
 * its own frame (Layout + header), so this page adds no container either.
 */

export const metadata: Metadata = {
  title: "Tổng quan — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getOperatorSession("page:/");

  // Defence in depth: middleware and the (app) layout already block this route,
  // but a Server Component must not trust that it was reached through a guard.
  if (!session) redirect("/signin?returnUrl=%2F");

  return (
    <>
      {/* Dev-only, and deliberately above the screen: nothing on this page may
          be trusted as real while the session is faked. */}
      {session.isDevFake ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground border-b px-6 py-2 text-xs"
        >
          Phiên giả lập DEV — chưa đăng nhập thật. Tắt biến DEV_FAKE_SESSION để dùng đăng nhập
          Google.
        </p>
      ) : null}

      <OverviewScreen />
    </>
  );
}
