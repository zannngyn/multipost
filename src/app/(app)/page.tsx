import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { TenantHealthPanel } from "@/ui/components/tenant/TenantHealthPanel";

/**
 * Protected home. Server Component: the session is resolved before anything
 * renders, so there is no "unknown" flash and no private markup can leak
 * (core-auth-session: three session states).
 *
 * The operator identity and the sign-out action now live in the shell's side
 * nav footer, so this page is content only.
 *
 * The overview proper (KPI tiles + "việc cần làm") lands in B4; today this is
 * still the walking-skeleton health check.
 */

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getOperatorSession("page:/");

  // Defence in depth: middleware and the (app) layout already block this route,
  // but a Server Component must not trust that it was reached through a guard.
  if (!session) redirect("/signin?returnUrl=%2F");

  return (
    <div className="flex w-full flex-col gap-8 px-6 py-8">
      <header className="space-y-1 border-b pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">MYSP — Đăng bài tự động</h1>
        {session.isDevFake ? (
          <p role="status" className="text-destructive text-xs">
            Phiên giả lập DEV — chưa đăng nhập thật. Tắt biến DEV_FAKE_SESSION để dùng đăng nhập
            Google.
          </p>
        ) : null}
      </header>

      <TenantHealthPanel />
    </div>
  );
}
