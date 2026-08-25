import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { readActiveTenantLabel } from "@/app/(app)/tenant-name";
import { signOut } from "@/app/_auth/auth";
import { getOperatorSession } from "@/app/_auth/session";
import { AppFrame } from "@/ui/components/shell/AppFrame";
import { NAV_COLLAPSED_COOKIE, isNavCollapsedCookie } from "@/ui/components/shell/nav-collapse";
import { TenantBoundary } from "@/ui/components/tenant/TenantBoundary";

/**
 * Shell for every operator screen. The session is resolved here, once, before
 * anything renders — so there is no "unknown" flash and no private markup can
 * leak (core-auth-session).
 *
 * Each page keeps its own guard as well: middleware and this layout both block
 * the route, but a Server Component must not trust that it was reached through
 * either.
 */

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

async function signOutOperator(): Promise<void> {
  "use server";
  // signOut() throws NEXT_REDIRECT — keep it out of try/catch.
  // NOTE (JWT stateless, see _auth/auth.config.ts): this clears the cookie in
  // THIS browser only. Other devices keep working until the token expires —
  // "đăng xuất mọi thiết bị" is not built yet.
  await signOut({ redirectTo: "/signin" });
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getOperatorSession("layout:(app)");

  if (!session) redirect("/signin");

  // The company of THIS session, not a hardcoded one (M1.4). Read here so the
  // top bar is correct in the first paint; the client learns the same fact from
  // `/api/me` for everything that has to react to a switch.
  //
  // The NAME only: since M2.1 the plan and the role live inside the switcher
  // menu, and a first paint that says more than the hydrated control would make
  // the label visibly change under the operator.
  const cookieHeader = (await headers()).get("cookie");
  const tenant = await readActiveTenantLabel(session, cookieHeader);

  // The nav's collapsed state has to be known HERE, before the shell renders:
  // read after hydration instead and every reload paints the wide nav and then
  // snaps it shut. Absent or unreadable cookie = expanded, the default state.
  const cookieStore = await cookies();
  const navCookie = cookieStore.get(NAV_COLLAPSED_COOKIE)?.value;

  return (
    <AppFrame
      operatorLabel={session.name ?? session.email}
      tenantName={tenant.name}
      navDefaultCollapsed={isNavCollapsedCookie(navCookie)}
      signOutAction={session.isDevFake ? undefined : signOutOperator}
    >
      {/* Blocks the screens below until a company is established — the picker
          and the first-run wizard live there. The sign-out action goes with it:
          that wizard is a required dialog, so it covers the top bar's own
          sign-out and has to carry one of its own. */}
      <TenantBoundary signOutAction={session.isDevFake ? undefined : signOutOperator}>
        {children}
      </TenantBoundary>
    </AppFrame>
  );
}
