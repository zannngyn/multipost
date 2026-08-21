"use client";

import { AppShell, LinkProvider, Theme } from "@astryxdesign/core";
import type { ReactNode } from "react";

import { AppLink } from "@/ui/components/shell/AppLink";
import { AppSideNav } from "@/ui/components/shell/AppSideNav";
import { AppTopBar } from "@/ui/components/shell/AppTopBar";
import { SupportModeBanner } from "@/ui/components/shell/SupportModeBanner";
// The BUILT theme (`astryx theme build` output), not the source module: a
// runtime theme injects its tokens after hydration, so the first paint would
// show the neutral ink and swap. Its CSS is imported once, in globals.css.
import { myspTheme } from "@/ui/theme/mysp";

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
    // Every Astryx link in the app goes through AppLink — see the note there
    // for the `to` attribute it exists to swallow.
    <LinkProvider component={AppLink}>
      <Theme theme={myspTheme}>
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
