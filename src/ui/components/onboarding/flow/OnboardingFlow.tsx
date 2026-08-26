"use client";

import { LinkProvider, Theme } from "@astryxdesign/core";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import { AppLink } from "@/ui/components/shell/AppLink";
import { Button } from "@/ui/components/ui/button";
import { myspTheme } from "@/ui/theme/mysp";

import { SlideShell } from "./SlideShell";
import {
  nextScreen,
  previousScreen,
  resolveScreen,
  type OnboardingScreen,
} from "./onboarding-steps";
import { usePassedSlides } from "./usePassedSlides";

/**
 * The survey flow itself.
 *
 * It holds no idea of "which step am I on". The URL carries an intent, the
 * answers carry the truth, `resolveScreen` reconciles them.
 *
 * TASK 5-9 REBUILD THIS FILE: the welcome screen, the four question screens and
 * the writes to `tenant_profile` land there. What is here is the state machine
 * wired up to placeholders, so the route still runs.
 */
export function OnboardingFlow({
  // The welcome screen is the only one that shows it, and `src/ui` may not
  // import `src/app`, so the Server Action arrives as a prop.
  signOutAction,
}: {
  signOutAction?: () => Promise<void>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isResolved, role } = useActiveTenant();
  const { passed, markPassed } = usePassedSlides();

  // --- Edge case: this flow is not for every role --------------------------
  // The survey describes the tenant, so only an owner or an admin answers it.
  // The check happens before the position is derived, not after.
  const isAllowedRole = role === "owner" || role === "admin";
  useEffect(() => {
    if (isResolved && !isAllowedRole) router.replace("/");
  }, [isResolved, isAllowedRole, router]);

  // Which way the next screen should enter. State, not a ref: the value is READ
  // WHILE RENDERING to pick the animation, and a ref read during render is both
  // a lint error here and a value React makes no promise about. The extra
  // render rides along with the navigation `goTo` is about to trigger anyway.
  const [direction, setDirection] = useState<1 | -1>(1);

  // PENDING(task-9): `answered` comes from `tenant_profile` once the endpoint
  // exists. Until then the session note is the only record of what was answered
  // or skipped, which is enough to walk the flow but not to survive a reload.
  const answered: Partial<Record<OnboardingScreen, boolean>> = Object.fromEntries(
    passed.map((id) => [id, true]),
  );

  const current = resolveScreen({
    requested: searchParams.get("step"),
    answered,
    hasStarted: passed.includes("welcome"),
  });

  const goTo = useCallback(
    (target: OnboardingScreen, way: 1 | -1) => {
      setDirection(way);
      const params = new URLSearchParams(searchParams.toString());
      params.set("step", target);
      // Drop the one-shot OAuth outcome so a refresh does not re-announce it.
      params.delete("google");
      params.delete("connect");
      params.delete("reason");
      router.replace(`/onboarding?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const advance = useCallback(() => {
    markPassed(current);
    const target = nextScreen(current);
    // The survey has no sixth screen: finishing it means leaving for the app.
    if (target === "done") {
      router.replace("/");
      return;
    }
    goTo(target, 1);
  }, [current, goTo, markPassed, router]);

  const goBack = useCallback(() => {
    const target = previousScreen(current);
    if (target) goTo(target, -1);
  }, [current, goTo]);

  if (isResolved && !isAllowedRole) return null;

  /* ONE shell for the whole flow, NOT one per screen: the story column has to
     survive the change of screen, or the heading and the rail would slide out
     and back in on every step. `SlideShell` keys the travelling half on `id`
     internally.

     NO SETUP-PROGRESS FETCH ANY MORE: the survey asks about the operator, not
     about the tenant's six connection flags, so nothing here has to wait on
     that endpoint — and an unrelated failure of it must not block the survey. */
  const content = (
    <SlideShell
      id={current}
      direction={direction}
      heading={HEADINGS[current]}
      lead={LEADS[current]}
      // The greeting has nothing to skip and nothing to go back to.
      onSkip={current === "welcome" ? undefined : advance}
      onBack={current === "welcome" ? undefined : goBack}
      exitHref="/"
      signOutAction={current === "welcome" ? signOutAction : undefined}
    >
      {/* Tasks 5-8 replace every placeholder below. */}
      <p className="text-muted-foreground text-sm">
        Nội dung màn này được lắp ở task sau ({current}).
      </p>
      {current === "welcome" ? (
        <Button type="button" onClick={advance}>
          Bắt đầu
        </Button>
      ) : null}
    </SlideShell>
  );

  /**
   * THE SAME THREE PROVIDERS `AppFrame` wraps the app in, for the same reason
   * `SignInScreen` repeats them: this route group sits OUTSIDE `(app)`, so
   * nothing above it mounts them.
   *
   * Without `<Theme>` every Astryx component rendered here — the error banner
   * today, the connection panels the later slides reuse — falls back to
   * Astryx's own palette: its blue `--color-accent` instead of Indigo Dye, and
   * the neutral theme's cold near-black instead of Warm Ink. That exact drift
   * was measured on /signin before its wrapper was added.
   *
   * NOTE (spec section 10): `<Theme>` is also what scopes `--color-text-primary`
   * onto the text below it, which is why every string in this flow declares its
   * own colour instead of inheriting one.
   */
  return (
    <LinkProvider component={AppLink}>
      <InternationalizationProvider
        locale={ASTRYX_LOCALE}
        messages={{ [ASTRYX_LOCALE]: ASTRYX_VI }}
      >
        <Theme theme={myspTheme}>{content}</Theme>
      </InternationalizationProvider>
    </LinkProvider>
  );
}

/**
 * Placeholder copy only. The real wording of each question lives in the step
 * components that tasks 5-8 add, next to the options it belongs with.
 */
const HEADINGS: Record<OnboardingScreen, string> = {
  welcome: "Chào mừng tới MYSP",
  seller: "Bạn đang bán hàng kiểu nào?",
  tools: "Bạn đang đăng bài bằng gì?",
  count: "Bạn đang quản lý bao nhiêu trang?",
  channels: "Kênh nào bạn đang tập trung?",
};

const LEADS: Record<OnboardingScreen, string> = {
  welcome: "Bốn câu hỏi ngắn để MYSP hiểu cách bạn đang bán hàng.",
  seller: "Chọn mô tả gần đúng nhất với bạn.",
  tools: "Chọn tất cả những gì bạn đang dùng.",
  count: "Số trang bạn đang đăng bài, không tính trang cá nhân.",
  channels: "Hiện MYSP đăng được Facebook; các kênh khác đang làm.",
};
