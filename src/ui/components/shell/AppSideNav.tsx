"use client";

import {
  Avatar,
  Button,
  Item,
  SideNav,
  SideNavItem,
  SideNavSection,
  Text,
  useAnnounce,
  useSideNavCollapse,
} from "@astryxdesign/core";
import {
  Building2,
  CalendarClock,
  FolderSync,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Radio,
  ScrollText,
  Share2,
  Sparkles,
  Users,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import { useState, useTransition } from "react";

import { isNavItemActive, visibleNavSections } from "@/ui/components/shell/nav-items";
import { useMe } from "@/ui/hooks/useMe";

/**
 * Primary navigation (core-accessibility): a landmark with grouped sections and
 * an explicit selected state, so a screen-reader user can tell where they are
 * without reading colours.
 *
 * Astryx ships no domain icons — its semantic registry is 28 utility names — but
 * `SideNavItem.icon` accepts `ComponentType<SVGProps<SVGSVGElement>>`, so these
 * come from lucide-react, already in the project's dependencies.
 */
const ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  "/": LayoutDashboard,
  "/compose": PenLine,
  "/bulk": Layers,
  "/scheduled": CalendarClock,
  "/jobs": ScrollText,
  "/products": ListChecks,
  "/sync": FolderSync,
  "/channels": Radio,
  "/channels/groups": Share2,
  "/prompts": Sparkles,
  "/members": Users,
  "/access": ScrollText,
  "/platform": Building2,
};

export function AppSideNav({
  operatorLabel,
  onSignOut,
}: {
  operatorLabel: string;
  /**
   * A Server Action handed down from the layout. This component sits in
   * `src/ui`, which may not import `src/app` (docs/07) — receiving the action as
   * a prop is how the boundary stays one-way.
   *
   * Absent for the dev bypass session, which has nothing to sign out of.
   */
  onSignOut?: () => Promise<void>;
}) {
  const pathname = usePathname();
  const me = useMe();

  /**
   * While `/api/me` is still loading this is false, so a privileged section is
   * never rendered and then taken away — an item that blinks into existence is
   * an item somebody clicks (core-auth-session: chống nháy hiện-rồi-biến-mất).
   *
   * The hiding is courtesy, not security: `/platform` guards itself on the
   * server, because "ẩn khỏi menu nhưng gõ thẳng URL vẫn vào được" is the hole
   * this rule exists to close.
   */
  const hasPlatformRole = (me.data?.account?.platformRole ?? null) !== null;
  const sections = visibleNavSections({ hasPlatformRole });

  return (
    <SideNav
      // Astryx's own toggle sits in the bottom icon bar, where Next's dev
      // overlay badge covers it. The nav owns a toggle of its own at the top
      // instead (see NavCollapseToggle).
      collapsible={{ hasButton: false }}
      resizable={{ defaultWidth: 256, minWidth: 240, maxWidth: 280, autoSaveId: "mysp-nav" }}
      // AppShell renders the top bar as a second navigation landmark, and a
      // screen reader lists both by name — "Side navigation" next to a
      // Vietnamese UI names neither one usefully.
      aria-label="Điều hướng chính"
      topContent={<NavCollapseToggle />}
      footer={<NavAccountBlock operatorLabel={operatorLabel} onSignOut={onSignOut} />}
    >
      {sections.map((section) => (
        <SideNavSection key={section.title} title={section.title}>
          {section.items.map((item) => (
            <SideNavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={ICONS[item.href]}
              // A batch detail page has no nav entry of its own; keep the log
              // section lit while one is open, so the operator does not lose
              // track of where they came from.
              isSelected={
                isNavItemActive(pathname, item.href, { exact: item.isExact }) ||
                (item.href === "/jobs" && isNavItemActive(pathname, "/batches"))
              }
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}

/**
 * The collapse toggle, as the first row of the menu.
 *
 * A SideNavItem rather than Astryx's SideNavCollapseButton: that button hardcodes
 * `isIconOnly`, so its `label` becomes an aria-label and never shows — and the
 * approved design asks for icon + text. As a nav row it also inherits the rail
 * behaviour of every other entry: icon only, name in a tooltip, once collapsed.
 */
function NavCollapseToggle() {
  const { isCollapsed, toggle, isCollapsible } = useSideNavCollapse();

  // Mobile renders the nav inside a drawer, outside the collapse context: there
  // is no rail to collapse, and a row that does nothing is worse than no row.
  if (!isCollapsible) return null;

  return (
    <SideNavItem
      label={isCollapsed ? "Mở rộng menu" : "Thu gọn menu"}
      icon={isCollapsed ? PanelLeftOpen : PanelLeftClose}
      onClick={toggle}
    />
  );
}

/**
 * The account block at the foot of the nav: who is signed in, and the only way
 * out of the session (M2.3 moved it here from the top bar).
 *
 * Sign-out is a real <button> with a visible label — not a menu row — because
 * the failure state has to be readable next to the control that caused it.
 */
function NavAccountBlock({
  operatorLabel,
  onSignOut,
}: {
  operatorLabel: string;
  onSignOut?: () => Promise<void>;
}) {
  const { isCollapsed } = useSideNavCollapse();
  const [isSigningOut, startSignOut] = useTransition();
  const [hasFailed, setHasFailed] = useState(false);
  const announce = useAnnounce();

  /**
   * A successful sign-out answers with a redirect, so this only ever returns on
   * failure. Nothing else would catch it: a rejected Server Action inside an
   * event handler reaches no error boundary, and the button would settle back
   * looking exactly like success while the session cookie is still there.
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
        // The failure text lands quietly at the foot of the nav. Someone on a
        // screen reader would hear nothing and believe they had signed out.
        announce("Đăng xuất không thành công, phiên đăng nhập vẫn còn.", "assertive");
      }
    });
  }

  const signOutLabel = isSigningOut
    ? "Đang đăng xuất…"
    : hasFailed
      ? "Thử đăng xuất lại"
      : "Đăng xuất";
  const failureHint = "Lần trước không thành công, phiên vẫn còn. Bấm để thử lại.";

  // Collapsed rail: no room for a name, so the avatar carries it in its tooltip
  // and the button goes icon-only. Nothing is dropped, only relabelled.
  if (isCollapsed) {
    return (
      <>
        <Avatar name={operatorLabel} size="sm" tooltip={operatorLabel} />
        {onSignOut ? (
          <Button
            label={signOutLabel}
            tooltip={hasFailed ? failureHint : signOutLabel}
            icon={<LogOut aria-hidden="true" />}
            isIconOnly
            size="sm"
            variant={hasFailed ? "destructive" : "ghost"}
            isDisabled={isSigningOut}
            onClick={() => signOut(onSignOut)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <Item
        density="compact"
        startContent={<Avatar name={operatorLabel} size="sm" tooltip={false} />}
        label={operatorLabel}
        labelLines={1}
        description={hasFailed ? failureHint : undefined}
        descriptionLines={2}
      />
      {onSignOut ? (
        <Button
          label={signOutLabel}
          icon={<LogOut aria-hidden="true" />}
          variant={hasFailed ? "destructive" : "ghost"}
          size="sm"
          width="100%"
          isDisabled={isSigningOut}
          onClick={() => signOut(onSignOut)}
        />
      ) : (
        // No control, because there is nothing to sign out of — a disabled
        // button here would only invite clicks that can never work.
        <Text type="supporting" color="disabled">
          Phiên phát triển — không có đăng xuất
        </Text>
      )}
    </>
  );
}
