"use client";

import { AppShell, LinkProvider, Stack, Text, Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { AppSideNav } from "@/ui/components/shell/AppSideNav";

/**
 * The app's single client boundary for the shell (web-layout-shell). Pages stay
 * Server Components and keep owning the session guard; they hand their rendered
 * content in as children.
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
  signOutAction,
}: {
  children: ReactNode;
  operatorLabel: string;
  signOutAction: ReactNode;
}) {
  return (
    <LinkProvider component={NextLink}>
      <Theme theme={neutralTheme}>
        <AppShell
          contentPadding={0}
          sideNav={
            <AppSideNav
              footer={
                <Stack direction="vertical" gap={1} padding={2}>
                  <Text type="label" maxLines={1}>
                    {operatorLabel}
                  </Text>
                  {signOutAction}
                </Stack>
              }
            />
          }
        >
          {children}
        </AppShell>
      </Theme>
    </LinkProvider>
  );
}
