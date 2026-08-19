"use client";

import { Avatar, DropdownMenu, TopNav, TopNavHeading, useAnnounce } from "@astryxdesign/core";
import type { DropdownMenuOption } from "@astryxdesign/core";
import { LogOut } from "lucide-react";
import { useState, useTransition } from "react";

import { AppSearch } from "@/ui/components/shell/AppSearch";

/**
 * The app's identity bar: who the product is, which shop it is reading, and who
 * is signed in. Branding lives here and nowhere else — Astryx warns that a
 * SideNavHeading next to a TopNav duplicates it, and two brand marks make the
 * page read as two apps.
 *
 * `onSignOut` is a Server Action handed down from the layout. This component
 * sits in `src/ui`, which may not import `src/app` (docs/07) — receiving the
 * action as a prop is how the boundary stays one-way.
 */
export function AppTopBar({
  operatorLabel,
  tenantName,
  onSignOut,
}: {
  operatorLabel: string;
  /** null when the tenant could not be read — the bar renders without it. */
  tenantName: string | null;
  /** Absent for the dev bypass session, which has nothing to sign out of. */
  onSignOut?: () => Promise<void>;
}) {
  const [isSigningOut, startSignOut] = useTransition();
  const [hasFailed, setHasFailed] = useState(false);
  const announce = useAnnounce();

  /**
   * A successful sign-out answers with a redirect, so this only ever returns on
   * failure. Nothing else would catch it: a rejected Server Action inside an
   * event handler reaches no error boundary, and the menu would close looking
   * exactly like success while the session cookie is still there.
   */
  function signOut(action: () => Promise<void>) {
    setHasFailed(false);
    // Async callback on purpose: a synchronous one ends the transition
    // immediately and `isSigningOut` would never be true.
    startSignOut(async () => {
      try {
        await action();
      } catch (error) {
        console.error("[shell] sign out failed", {
          error_code: "SIGN_OUT_FAILED",
          err: error,
        });
        setHasFailed(true);
        // The failure text lands quietly inside the menu item. Someone on a
        // screen reader would hear nothing and believe they had signed out.
        announce("Đăng xuất không thành công, phiên đăng nhập vẫn còn.", "assertive");
      }
    });
  }

  const accountItems: DropdownMenuOption[] = [
    {
      type: "section",
      title: operatorLabel,
      items: onSignOut
        ? [
            {
              id: "sign-out",
              label: isSigningOut ? "Đang đăng xuất…" : "Đăng xuất",
              description: hasFailed
                ? "Lần trước không thành công, phiên vẫn còn. Bấm để thử lại."
                : undefined,
              variant: hasFailed ? "destructive" : "default",
              icon: <LogOut aria-hidden="true" />,
              isDisabled: isSigningOut,
              // Keep the menu open: closing it on click would hide the failure,
              // and a successful sign-out navigates away regardless.
              hasCloseOnSelect: false,
              onClick: () => signOut(onSignOut),
            },
          ]
        : [
            {
              id: "dev-session",
              label: "Phiên phát triển — không có đăng xuất",
              isDisabled: true,
            },
          ],
    },
  ];

  return (
    <TopNav
      label="Thanh trên cùng"
      heading={<TopNavHeading heading="MYSP" headingHref="/" subheading={tenantName ?? undefined} />}
      endContent={
        <>
          <AppSearch />
          <DropdownMenu
            items={accountItems}
            hasChevron={false}
            alignment="end"
            menuWidth={280}
            button={{
              label: `Tài khoản: ${operatorLabel}`,
              isIconOnly: true,
              variant: "ghost",
              size: "sm",
              icon: <Avatar name={operatorLabel} size="sm" tooltip={false} />,
            }}
          />
        </>
      }
    />
  );
}
