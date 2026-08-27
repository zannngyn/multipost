"use server";

import { cookies } from "next/headers";

import { signOut } from "@/app/_auth/auth";
import { ACTIVE_TENANT_COOKIE } from "@/app/_lib/active-tenant-cookie";

/**
 * THE way out of the app — one copy, shared by the shell (`(app)/layout.tsx`)
 * and by `/onboarding`, which sits outside the shell and has no top bar.
 *
 * Signing out takes the ACTIVE-TENANT SELECTOR with it. It has to: the selector
 * lives for 30 days and is NOT a credential, so it used to outlive the session
 * that chose it and greet the NEXT account in this browser with a company it
 * has never been in. Every tenant-scoped route then answered 404 while
 * `/api/me` — reading the very same cookie — drew the app around the company
 * that account does have. `requireTenant` no longer refuses that selector
 * (composition/require-tenant.ts), but the cookie should never have been left
 * behind in the first place: one operator's choice is not the next one's.
 *
 * Deleted BEFORE `signOut()`, which throws NEXT_REDIRECT — nothing after it
 * runs. Both mutations ride the same response.
 *
 * NOTE (JWT stateless, see _auth/auth.config.ts): this clears the cookies in
 * THIS browser only. Other devices keep working until the token expires —
 * "đăng xuất mọi thiết bị" is not built yet.
 */
export async function signOutOperator(): Promise<void> {
  const cookieStore = await cookies();
  /**
   * `Secure` and `HttpOnly` are deliberately absent: a cookie is identified by
   * name + domain + path, so the deletion matches whatever attributes the
   * selector was written with — including the `Secure` production sets.
   */
  cookieStore.delete({ name: ACTIVE_TENANT_COOKIE, path: "/" });

  await signOut({ redirectTo: "/signin" });
}
