/**
 * "Am I still inside a company, or am I in MYSP's own admin screens?" — kept
 * free of React so the rule can be tested in the node environment the project
 * already uses, next to the other shell rules.
 *
 * WHY IT IS ITS OWN RULE: `/platform` is the one place in the shell where the
 * company shown in the top bar is NOT what the screen is about — it lists other
 * people's companies. Without a marker, an MYSP operator reads a customer list
 * under their own company name and answers about the wrong shop (the same
 * failure `SupportModeBanner` guards against, one level up).
 */

import { isNavItemActive } from "@/ui/components/shell/nav-items";

/** The section root. Matches the nav entry — one path, one definition. */
export const PLATFORM_ROOT = "/platform";

/**
 * Shown next to the company switcher, never instead of it: switching company
 * from the platform screens stays legal, the badge only says the screen below
 * does not belong to that company.
 */
export const OUT_OF_TENANT_LABEL = "Ngoài công ty — màn quản trị MYSP";

/**
 * `usePathname()` is typed `string` in the App Router but can be null while a
 * route is being resolved, so the argument is widened rather than asserted —
 * an unknown route reads as "inside a company", the state that shows no badge
 * and therefore claims nothing.
 *
 * Matching is segment-aware (borrowed from the nav's active rule, not
 * re-implemented): "/platformer" is a different section and must not light this
 * up.
 */
export function isPlatformContext(pathname: string | null | undefined): boolean {
  if (typeof pathname !== "string" || pathname === "") return false;
  return isNavItemActive(pathname, PLATFORM_ROOT);
}

/**
 * The whole condition for showing the badge, in one testable place.
 *
 * BOTH HALVES ARE LOAD-BEARING, and each fails differently:
 *   wrong route  — a badge saying "ngoài công ty" on a screen that IS about the
 *                  company is a lie the operator will act on;
 *   no platform  — an account without a platform role gets `PlatformForbidden`
 *      role       at this URL, so telling them they are inside MYSP's admin
 *                 screens describes a screen they cannot see. It is also false
 *                 while `/api/me` is still loading, which is what stops the
 *                 badge being painted and then taken away.
 *
 * Pure, so both halves can be checked without rendering — a component test
 * would need a router and a query client to assert one boolean.
 */
export function shouldShowOutOfTenantBadge(input: {
  pathname: string | null | undefined;
  /** `account.platformRole` from /api/me — `null` until it is known. */
  platformRole: string | null | undefined;
}): boolean {
  if (!isPlatformContext(input?.pathname)) return false;
  return typeof input.platformRole === "string" && input.platformRole.length > 0;
}
