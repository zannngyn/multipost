"use client";

import { AppShell, LinkProvider, Theme } from "@astryxdesign/core";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import type { ReactNode } from "react";

import { cn } from "@/shared/utils";

import { useHandoffArrival } from "@/ui/hooks/useHandoffArrival";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import { SetupDock } from "@/ui/components/onboarding/SetupDock";
import { AppLink } from "@/ui/components/shell/AppLink";
import { AppSideNav } from "@/ui/components/shell/AppSideNav";
import { AppTopBar } from "@/ui/components/shell/AppTopBar";
import { SupportModeBanner } from "@/ui/components/shell/SupportModeBanner";
// The BUILT theme (`astryx theme build` output), not the source module: a
// runtime theme injects its tokens after hydration, so the first paint would
// show the neutral ink and swap. Its CSS is imported once, in globals.css.
import { myspTheme } from "@/ui/theme/mysp";

import "./handoff-motion.css";

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
  /**
   * VỪA TỪ ONBOARDING BƯỚC VÀO. Đọc TRONG LÚC RENDER, không phải trong effect:
   * class phải có mặt ở khung hình đầu tiên, nếu không app hiện đủ nét một
   * khung rồi mới mờ vào — đúng cái nháy mà cú bàn giao để tránh.
   *
   * `false` ở mọi lần tải trang thật, nên không có hydration mismatch và không
   * có hiệu ứng nào phát lại khi người dùng chỉ đơn giản là mở lại tab.
   */
  const isHandoffArrival = useHandoffArrival();

  return (
    // Every Astryx link in the app goes through AppLink — see the note there
    // for the `to` attribute it exists to swallow.
    <LinkProvider component={AppLink}>
      {/* Astryx prints its own strings — "Search…", "Required", "Close" — and
          this app has exactly one audience, who reads Vietnamese. No `dir`:
          `vi` is LTR, so the <html dir> the docs ask for is already right. */}
      <InternationalizationProvider
        locale={ASTRYX_LOCALE}
        messages={{ [ASTRYX_LOCALE]: ASTRYX_VI }}
      >
        <Theme theme={myspTheme}>
          <AppShell
            contentPadding={0}
            topNav={<AppTopBar tenantName={tenantName} />}
            // The account block lives at the foot of the nav, so the session
            // props travel down this side of the shell.
            sideNav={
              <AppSideNav
                operatorLabel={operatorLabel}
                onSignOut={signOutAction}
                defaultCollapsed={navDefaultCollapsed}
              />
            }
          >
            {/* Above every screen, on purpose (M3.3): while MYSP staff are
                inside a customer's company, no screen may look like their own.
                It pushes content down instead of floating over it. */}
            <SupportModeBanner />
            {/* `relative`, and it is load-bearing.
                `sr-only` is `position: absolute`, so every visually hidden node
                anchors to the nearest POSITIONED ancestor. AppShell's content
                element is `position: static`, so they were escaping the scroll
                container entirely and landing at their un-scrolled static
                position on the shell wrapper above it — which stretched
                `documentElement.scrollHeight` past the viewport (1382 vs 900 on
                /sync, 3625 on the job log) and let the whole page drag down onto
                a band of empty background. Nothing visible moved, so the only
                symptom was a scrollbar with nothing in it.
                `h-full`, not auto: screens size themselves with `h-full` against
                this box, exactly as they did against the content element. */}
            {/* Cú mờ lên của bàn giao nằm ở ĐÂY, trên vùng nội dung, chứ
                không bọc quanh `AppShell`. `Layout` của Astryx cao `100%` của
                thẻ cha, nên chèn thêm một lớp bọc giữa nó và <body> là đụng vào
                mô hình cuộn của cả app để lấy 400ms hiệu ứng — đổi sai. Thanh
                nav và thanh trên hiện ngay: khung app đứng yên, nội dung là thứ
                đi tới. */}
            <div
              className={cn(
                "relative h-full min-h-0",
                isHandoffArrival && "app-handoff-in",
              )}
            >
              {children}
            </div>
            {/* The setup pointer lives in the SHELL, not on a screen: the steps
                it lists are spread across /sync, /channels and /compose, and an
                operator sent to one of them would otherwise lose the list they
                were working through. It decides for itself whether to appear —
                nothing here has to know about onboarding. */}
            <SetupDock />
          </AppShell>
        </Theme>
      </InternationalizationProvider>
    </LinkProvider>
  );
}
