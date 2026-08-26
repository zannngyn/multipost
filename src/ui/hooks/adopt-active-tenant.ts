import { hashKey, type QueryClient } from "@tanstack/react-query";

import { fetchMe, meKeys } from "@/ui/services/me.api";

/**
 * What the browser does to its cache when the ACTIVE COMPANY changes — the
 * shared ending of switching (M2.3), creating (M2.1), accepting an invite
 * (M2.2), the first-run provisioning (E10) and both ends of a support session
 * (M3.3).
 *
 * Outside React on purpose: the rule below is the difference between "the new
 * company arrives on screen" and "the tab keeps believing the old answer until
 * something unrelated happens to re-render", and vitest here runs
 * `environment: "node"` with no DOM. A rule that can silently swallow the one
 * moment a new account is shown its welcome has to be testable directly.
 *
 * TWO different verbs, and swapping either one breaks something real:
 *
 * 1. EVERY OTHER QUERY IS REMOVED. Anything still holding company A's rows
 *    would be shown under company B's name (core-auth-session §Nhiều tổ chức:
 *    "chuyển tổ chức mà không dọn cache = rò rỉ dữ liệu giữa các tổ chức").
 *    Removal also throws away infinite-query pages, so a products cursor from
 *    the previous company cannot be sent to the new one (docs/11 §4).
 *
 *    NOT `resetQueries()` over the whole cache: reset REFETCHES active queries,
 *    and those still carry the previous company's `tenantKey` in their key. The
 *    server answers from the cookie, which has already moved — so company B's
 *    rows would be written under company A's cache key and served instantly the
 *    next time the operator switches back. A worse leak than the one being
 *    fixed, and a silent one.
 *
 * 2. IDENTITY IS RESET, NOT REMOVED. `removeQueries` DETACHES the observers
 *    mounted on that query: they keep rendering the payload they last saw, and
 *    a `fetchQuery` afterwards builds a NEW query object they are not
 *    subscribed to. They only re-attach on their component's next render — and
 *    `TenantBoundary`, which is what the whole app waits on, has no reason to
 *    render again, because the only thing that could have told it to was the
 *    query that was just removed.
 *
 *    That is the bug this function exists to end: a brand-new account was
 *    provisioned a company (`ensure-default` → 201), and the tree kept reading
 *    "member of nothing" forever, so `/onboarding` was never reached and the
 *    welcome screen was missed — once, permanently, for that account.
 *
 *    `resetQueries` keeps the observers subscribed: they are pushed back to
 *    pending (no stale company on screen, which invalidation would have left
 *    there) and then handed the fresh answer, which re-renders the tree by
 *    itself.
 */
const ME_QUERY_HASH = hashKey(meKeys.me());

export async function adoptActiveTenantCache(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ predicate: (query) => query.queryHash !== ME_QUERY_HASH });

  await queryClient.resetQueries({ queryKey: meKeys.me(), exact: true });

  /**
   * A reset only refetches for observers that are MOUNTED. `/join/<token>`
   * renders outside the app shell and has none, so without this the cache would
   * be left empty and the screen it navigates into would start from a skeleton.
   * `ensureQueryData` returns what the reset already fetched when there was an
   * observer — it does not fetch twice.
   */
  await queryClient.ensureQueryData({
    queryKey: meKeys.me(),
    queryFn: ({ signal }) => fetchMe(signal),
  });
}
