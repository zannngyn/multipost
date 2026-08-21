import { redirect } from "next/navigation";

import { legacyRedirectTarget } from "@/ui/components/posts/legacy-routes";

/**
 * `/scheduled` moved into the "Bài đăng" hub (wave-1 IA). It stays as a
 * redirect, not a 404: operators bookmarked it, `usePublishForm` still pushes
 * here after a scheduled post, and the query string is worth keeping — a saved
 * `?view=calendar` must still open the calendar.
 *
 * No session guard of its own: the redirect leaks nothing, and `/posts` runs
 * the guard the moment the browser lands there.
 */

export const dynamic = "force-dynamic";

export default async function ScheduledRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") params.set(k, v);
  }
  // redirect() throws NEXT_REDIRECT — it must stay outside try/catch.
  redirect(legacyRedirectTarget("/scheduled", params.toString()) ?? "/posts");
}
