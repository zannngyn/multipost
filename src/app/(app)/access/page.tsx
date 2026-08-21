import { redirect } from "next/navigation";

import { legacyRedirectTarget } from "@/ui/components/posts/legacy-routes";

/**
 * `/access` moved into the "Thành viên" hub as its "Lịch sử duyệt" tab (wave-1
 * IA). It stays as a redirect, not a 404: it is the address in every link and
 * bookmark already sent around, and the `?status=` filter travels with it —
 * `/access?status=approved` lands on `/members?tab=history&status=approved`.
 *
 * No session or role guard of its own: the redirect leaks nothing, and
 * `/members` runs both guards the moment the browser lands there — an operator
 * without `canManageAccess` gets the same refusal the old route gave them.
 */

export const dynamic = "force-dynamic";

export default async function AccessRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") params.set(k, v);
  }
  // redirect() throws NEXT_REDIRECT — it must stay outside try/catch.
  redirect(legacyRedirectTarget("/access", params.toString()) ?? "/members");
}
