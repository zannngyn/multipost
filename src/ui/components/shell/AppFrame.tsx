"use client";

import { AppShell, LinkProvider, Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { AppSideNav } from "@/ui/components/shell/AppSideNav";
import { AppTopBar } from "@/ui/components/shell/AppTopBar";
import { SupportModeBanner } from "@/ui/components/shell/SupportModeBanner";

/**
 * The app's single client boundary for the shell (web-layout-shell). Pages stay
 * Server Components and keep owning the session guard; they hand their rendered
 * content in as children.
 *
 * Two bands, as in the sync-flow design: a full-width identity bar on top
 * (brand, shop, search), the destination list and the account block down the
 * side. AppShell
 * owns the scroll model — the frame is fixed and only the content scrolls — so
 * neither band may grow with the page.
 *
 * `AppShell` renders its own <main>, so pages must not render one themselves —
 * nested <main> landmarks break screen-reader navigation.
 *
 * `contentPadding={0}`: the dominant content pattern here is dense tables, which
 * run edge-to-edge. Screens that need padding set it on their own container.
 */
export function AppFrame({
  children,
  operatorLabel,
  tenantName,
  signOutAction,
  navDefaultCollapsed,
}: {
  children: ReactNode;
  operatorLabel: string;
  tenantName: string | null;
  signOutAction?: () => Promise<void>;
  /**
   * The collapsed state the server read from the nav cookie. Passed down rather
   * than read here so the first paint already matches what the operator left
   * behind — a client-side read would render the wide nav first.
   */
  navDefaultCollapsed: boolean;
}) {
  return (
    <LinkProvider component={NextLink}>
      <Theme theme={neutralTheme}>
        <AppShell
          contentPadding={0}
          topNav={<AppTopBar tenantName={tenantName} />}
          // The account block lives at the foot of the nav, so the session props
          // travel down this side of the shell.
          sideNav={
            <AppSideNav
              operatorLabel={operatorLabel}
              onSignOut={signOutAction}
              defaultCollapsed={navDefaultCollapsed}
            />
          }
        >
          {/* Above every screen, on purpose (M3.3): while MYSP staff are inside
              a customer's company, no screen may look like their own. It pushes
              content down instead of floating over it. */}
          <SupportModeBanner />
          {children}
        </AppShell>
      </Theme>
    </LinkProvider>
  );
}
