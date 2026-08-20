"use client";

import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core";
import {
  Building2,
  CalendarClock,
  FolderSync,
  Layers,
  LayoutDashboard,
  ListChecks,
  PenLine,
  Radio,
  ScrollText,
  Share2,
  Sparkles,
  Users,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

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

export function AppSideNav() {
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
      collapsible
      resizable={{ defaultWidth: 256, minWidth: 240, maxWidth: 280, autoSaveId: "mysp-nav" }}
      // AppShell renders the top bar as a second navigation landmark, and a
      // screen reader lists both by name — "Side navigation" next to a
      // Vietnamese UI names neither one usefully.
      aria-label="Điều hướng chính"
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
