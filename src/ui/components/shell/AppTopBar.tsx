"use client";

import { TopNav, TopNavHeading } from "@astryxdesign/core";

import { AppSearch } from "@/ui/components/shell/AppSearch";
import { TenantSwitcher } from "@/ui/components/shell/TenantSwitcher";

/**
 * The app's identity bar: who the product is, which shop it is reading, and how
 * to search it. Branding lives here and nowhere else — Astryx warns that a
 * SideNavHeading next to a TopNav duplicates it, and two brand marks make the
 * page read as two apps.
 *
 * The account (avatar, sign-out) is NOT here: it sits at the foot of the side
 * nav, so there is one place to look for "who am I and how do I leave".
 */
export function AppTopBar({
  tenantName,
}: {
  /**
   * What the SERVER resolved for this request — the first paint, before
   * `/api/me` answers on the client. Null when no company is established yet;
   * the switcher then says so itself.
   */
  tenantName: string | null;
}) {
  return (
    <TopNav
      label="Thanh trên cùng"
      heading={<TopNavHeading heading="MYSP" headingHref="/" />}
      // The company is no longer a label but a control (M2.3): it says where
      // you are AND is the way out of it, plus the only door to "tạo công ty".
      startContent={<TenantSwitcher fallbackLabel={tenantName} />}
      endContent={<AppSearch />}
    />
  );
}
