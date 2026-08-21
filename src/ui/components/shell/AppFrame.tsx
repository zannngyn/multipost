"use client";

import { AppShell } from "@astryxdesign/core";
import type { ReactNode } from "react";

import { AppSideNav } from "@/ui/components/shell/AppSideNav";
import { AppTopBar } from "@/ui/components/shell/AppTopBar";
import { SupportModeBanner } from "@/ui/components/shell/SupportModeBanner";

/**
 * The app's single client boundary for the shell (web-layout-shell). Pages stay
 * Server Components and keep owning the session guard; they hand their rendered
 * content in as children.
 *
 * Three bands, outside in: a session-wide banner strip, a full-width identity
 * bar (brand, company, search), and the destination list plus the account block
 * down the side. AppShell owns the scroll model — the frame is fixed and only
 * the content scrolls — so none of the three may grow with the page.
 *
 * Responsive contract (Astryx §Frame First):
 *   > 768px   nav 240-280 resizable | content fills the rest
 *   <= 768px  the nav folds into AppShell's mobile drawer; the top bar keeps
 *             the brand, the company and the toggle
 *
 * `AppShell` renders its own <main>, so pages must not render one themselves —
 * nested <main> landmarks break screen-reader navigation.
 *
 * `contentPadding={0}`: the dominant content pattern here is dense tables, which
 * run edge-to-edge. Screens that need padding set it on their own container
 * (the dashboard uses padding 6).
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
  // No Theme / LinkProvider here: both moved up to `app/providers.tsx` so the
  // routes OUTSIDE this shell (/signin, /join/<token>, error.tsx) get the
  // neutral theme too. Re-wrapping here would register a nested Theme for no
  // gain.
  return (
    <AppShell
      contentPadding={0}
      // Above the top bar, in AppShell's own banner landmark (M3.3): while
      // MYSP staff are inside a customer's company, no screen may look like
      // their own. Inside the content area it scrolled away with the page —
      // a standing warning that leaves the viewport is a warning that gets
      // forgotten. It renders nothing outside support mode.
      banner={<SupportModeBanner />}
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
      {children}
    </AppShell>
  );
}
