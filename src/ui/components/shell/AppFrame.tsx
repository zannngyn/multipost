"use client";

import { AppShell, LinkProvider, Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { AppSideNav } from "@/ui/components/shell/AppSideNav";
import { AppTopBar } from "@/ui/components/shell/AppTopBar";

/**
 * The app's single client boundary for the shell (web-layout-shell). Pages stay
 * Server Components and keep owning the session guard; they hand their rendered
 * content in as children.
 *
 * Two bands, as in the sync-flow design: a full-width identity bar on top
 * (brand, shop, search, account), the destination list down the side. AppShell
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
}: {
  children: ReactNode;
  operatorLabel: string;
  tenantName: string | null;
  signOutAction?: () => Promise<void>;
}) {
  return (
    <LinkProvider component={NextLink}>
      <Theme theme={neutralTheme}>
        <AppShell
          contentPadding={0}
          topNav={
            <AppTopBar
              operatorLabel={operatorLabel}
              tenantName={tenantName}
              onSignOut={signOutAction}
            />
          }
          sideNav={<AppSideNav />}
        >
          {children}
        </AppShell>
      </Theme>
    </LinkProvider>
  );
}
