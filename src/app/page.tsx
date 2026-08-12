import { redirect } from "next/navigation";

import { signOut } from "@/app/_auth/auth";
import { getOperatorSession } from "@/app/_auth/session";
import { TenantHealthPanel } from "@/ui/components/tenant/TenantHealthPanel";
import { Button } from "@/ui/components/ui/button";

/**
 * Protected home — walking skeleton for E1. Server Component: the session is
 * resolved before anything renders, so there is no "unknown" flash and no
 * private markup can leak (core-auth-session: three session states).
 *
 * Real operator screens (wizard, duyệt caption, theo dõi) land in E10.
 */

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getOperatorSession("page:/");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2F");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">MYSP — Đăng bài tự động</h1>
          <p className="text-muted-foreground text-sm">
            Đang đăng nhập: <span className="font-medium">{session.name ?? session.email}</span>{" "}
            <span className="font-mono text-xs">({session.email})</span>
          </p>
        </div>

        {session.isDevFake ? (
          <p
            role="status"
            className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-xs"
          >
            Phiên giả lập DEV — chưa đăng nhập thật. Tắt biến DEV_FAKE_SESSION để dùng đăng nhập
            Google.
          </p>
        ) : (
          <form
            action={async () => {
              "use server";
              // signOut() throws NEXT_REDIRECT — keep it out of try/catch.
              // NOTE (JWT stateless, see _auth/auth.config.ts): this clears the
              // cookie in THIS browser only. Other devices keep working until
              // the token expires — "đăng xuất mọi thiết bị" is not built yet.
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <Button type="submit" variant="outline">
              Đăng xuất
            </Button>
          </form>
        )}
      </header>

      <main className="flex-1">
        <TenantHealthPanel />
      </main>
    </div>
  );
}
