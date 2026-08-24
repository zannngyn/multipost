import { redirect } from "next/navigation";

import {
  legacyRedirectQuery,
  legacyRedirectTarget,
} from "@/ui/components/posts/legacy-routes";

/**
 * `/jobs` moved into the "Bài đăng" hub (wave-1 IA). It stays as a redirect,
 * not a 404: `/jobs?batchId=…` and `/jobs?status=failed` are the two links
 * pasted into support threads, and the query string must survive the move.
 *
 * No session guard of its own: the redirect leaks nothing, and `/posts` runs
 * the guard the moment the browser lands there.
 */

export const dynamic = "force-dynamic";

export default async function JobsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Repeated parameters are kept, not dropped — same as the edge redirect does
  // (`legacyRedirectQuery`).
  const query = legacyRedirectQuery(await searchParams);
  // redirect() throws NEXT_REDIRECT — it must stay outside try/catch.
  redirect(legacyRedirectTarget("/jobs", query) ?? "/posts");
}
