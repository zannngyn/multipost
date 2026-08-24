import { redirect } from "next/navigation";

import {
  legacyRedirectQuery,
  legacyRedirectTarget,
} from "@/ui/components/posts/legacy-routes";

/**
 * `/channels/groups` moved into the "Kênh" hub (wave-1 IA). It stays as a
 * redirect, not a 404: it is the address in every "tạo nhóm kênh" link already
 * sent around, and the query string travels with it.
 *
 * No session guard of its own: the redirect leaks nothing, and `/channels` runs
 * the guard the moment the browser lands there.
 */

export const dynamic = "force-dynamic";

export default async function ChannelGroupsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Repeated parameters are kept, not dropped — same as the edge redirect does
  // (`legacyRedirectQuery`).
  const query = legacyRedirectQuery(await searchParams);
  // redirect() throws NEXT_REDIRECT — it must stay outside try/catch.
  redirect(legacyRedirectTarget("/channels/groups", query) ?? "/channels");
}
