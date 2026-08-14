"use client";

import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core";
import {
  CalendarClock,
  FolderSync,
  Layers,
  LayoutDashboard,
  ListChecks,
  PenLine,
  Radio,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { NAV_SECTIONS, isNavItemActive } from "@/ui/components/shell/nav-items";

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
  "/prompts": Sparkles,
};

export function AppSideNav({ footer }: { footer: ReactNode }) {
  const pathname = usePathname();

  return (
    <SideNav
      collapsible
      resizable={{ defaultWidth: 256, minWidth: 240, maxWidth: 280, autoSaveId: "mysp-nav" }}
      footer={footer}
    >
      {NAV_SECTIONS.map((section) => (
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
                isNavItemActive(pathname, item.href) ||
                (item.href === "/jobs" && isNavItemActive(pathname, "/batches"))
              }
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
