"use client";

import { Badge } from "@astryxdesign/core";
import { usePathname } from "next/navigation";

import { OUT_OF_TENANT_LABEL, isPlatformContext } from "@/ui/components/shell/platform-context";
import { useMe } from "@/ui/hooks/useMe";

/**
 * The standing marker for MYSP's own admin screens, sitting beside the company
 * switcher in the top bar.
 *
 * WHY BESIDE THE SWITCHER: that control is exactly what it qualifies — the bar
 * says "Công ty: X" while the screen below is about every company but X. Read
 * apart, the two facts contradict each other; read together, they do not.
 *
 * The switcher stays live: changing company from here is legal, it just does
 * not change what these screens show.
 *
 * `Badge`, not `Token`: this is a read-only state of the session, not a tag or
 * a removable selection (Astryx Token is for the latter). `info`, not
 * `warning`: being on the admin screens is normal for whoever can see them —
 * nothing is wrong and nothing needs fixing. Support mode, which IS a warning,
 * has its own banner.
 */
export function OutOfTenantBadge() {
  const pathname = usePathname();
  const me = useMe();

  /**
   * The same test the sidebar and the palette use, for the same reason: an
   * account without a platform role gets `PlatformForbidden` at this URL, so
   * telling them they are "trong màn quản trị MYSP" would be a plain lie about
   * a screen they cannot see.
   *
   * False while `/api/me` is still loading, so the badge is never painted and
   * then taken away — same rule as `visibleNavSections`.
   */
  const hasPlatformRole = (me.data?.account?.platformRole ?? null) !== null;

  // Every other screen: nothing rendered at all. A badge that says "trong công
  // ty" on ten screens would be the noise Astryx warns about, and would stop
  // being noticed on the one screen it matters.
  if (!isPlatformContext(pathname)) return null;
  if (!hasPlatformRole) return null;

  return <Badge variant="info" label={OUT_OF_TENANT_LABEL} />;
}
