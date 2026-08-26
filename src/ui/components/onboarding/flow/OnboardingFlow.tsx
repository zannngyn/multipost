"use client";

import { LinkProvider, Theme } from "@astryxdesign/core";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppLink } from "@/ui/components/shell/AppLink";
import { useActiveTenant, useMe } from "@/ui/hooks/useMe";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import type {
  ChannelCount,
  FocusChannel,
  SellerKind,
  ToolKind,
} from "@/ui/schemas/onboarding-profile.schema";
import { myspTheme } from "@/ui/theme/mysp";

import { OnboardingFrame } from "./OnboardingFrame";
import { StepChannels } from "./StepChannels";
import { StepCount } from "./StepCount";
import { StepSeller } from "./StepSeller";
import { StepTools } from "./StepTools";
import { WelcomeScreen } from "./WelcomeScreen";
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
 * ALL FIVE SCREENS ARE REAL AS OF TASK 8. What is still missing is task 9:
 * every answer lives in this component's state and nothing is written to
 * `tenant_profile` yet, so a reload starts the survey over.
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
  const me = useMe();
  const { isResolved, role } = useActiveTenant();
  const { passed, markPassed } = usePassedSlides();

  /**
   * PENDING(task-9): the answers live here until `tenant_profile` is wired up.
   * State, not a ref, because the cards and the Continue button both read it;
   * `readonly ToolKind[]` rather than a Set so the value can go straight into
   * the PATCH body task 9 sends.
   */
  const [sellerKind, setSellerKind] = useState<SellerKind | null>(null);
  const [currentTools, setCurrentTools] = useState<readonly ToolKind[]>([]);
  const [channelCount, setChannelCount] = useState<ChannelCount | null>(null);
  const [focusChannels, setFocusChannels] = useState<readonly FocusChannel[]>([]);

  // --- Edge case: this flow is not for every role --------------------------
  // The survey describes the tenant, so only an owner or an admin answers it.
  // The check happens before the position is derived, not after.
  const isAllowedRole = role === "owner" || role === "admin";
  useEffect(() => {
    if (isResolved && !isAllowedRole) router.replace("/");
  }, [isResolved, isAllowedRole, router]);

  // PENDING(task-9): `answered` comes from `tenant_profile` once the endpoint
  // exists. Until then the session note is the only record of what was answered
  // or skipped, which is enough to walk the flow but not to survive a reload.
  const answered: Partial<Record<OnboardingScreen, boolean>> = Object.fromEntries(
    passed.map((id) => [id, true]),
  );

  // Trimmed to null: a whitespace-only display name is not a name, and would
  // render "Chào  👋" with a hole in it.
  const trimmedName = me.data?.account?.displayName?.trim() ?? "";
  const displayName = trimmedName.length > 0 ? trimmedName : null;

  const current = resolveScreen({
    requested: searchParams.get("step"),
    answered,
    hasStarted: passed.includes("welcome"),
  });

  const goTo = useCallback(
    (target: OnboardingScreen) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("step", target);
      // Drop the one-shot OAuth outcome so a refresh does not re-announce it.
      params.delete("google");
      params.delete("connect");
      params.delete("reason");
      /**
       * PUSH, NOT REPLACE. `web-wizard` section 1: "Chuyển bước dùng push (back
       * quay lui một bước), không dùng replace". With `replace` the browser's
       * Back button left the flow altogether instead of stepping back one
       * question — a wizard whose Back button escapes the wizard.
       */
      router.push(`/onboarding?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const advance = useCallback(() => {
    markPassed(current);
    const target = nextScreen(current);
    // The survey has no sixth screen: finishing it means leaving for the app.
    // `replace`, deliberately — the flow is done, and Back must not re-enter it.
    if (target === "done") {
      router.replace("/");
      return;
    }
    goTo(target);
  }, [current, goTo, markPassed, router]);

  /**
   * "Bỏ qua" is a decision, not an absence (spec section 7.2): it drops the
   * answer for the step being left and moves on. Dropping it matters — a card
   * ticked and then skipped must not be written by task 9 as if it had been
   * confirmed, and must not be ticked again when the back arrow returns here.
   */
  const skip = useCallback(() => {
    if (current === "seller") setSellerKind(null);
    if (current === "tools") setCurrentTools([]);
    if (current === "count") setChannelCount(null);
    if (current === "channels") setFocusChannels([]);
    advance();
  }, [advance, current]);

  const toggleTool = useCallback((value: ToolKind, isChecked: boolean) => {
    setCurrentTools((previous) => {
      if (!isChecked) return previous.filter((tool) => tool !== value);
      // Guard against a double-add: `onToggle` fires per change, but a repeated
      // "checked" would otherwise send the same code twice in the PATCH body.
      return previous.includes(value) ? previous : [...previous, value];
    });
  }, []);

  /** Same shape as `toggleTool`, and same reason for the duplicate guard. */
  const toggleChannel = useCallback((value: FocusChannel, isChecked: boolean) => {
    setFocusChannels((previous) => {
      if (!isChecked) return previous.filter((channel) => channel !== value);
      return previous.includes(value) ? previous : [...previous, value];
    });
  }, []);

  const goBack = useCallback(() => {
    const target = previousScreen(current);
    if (target) goTo(target);
  }, [current, goTo]);

  if (isResolved && !isAllowedRole) return null;

  /**
   * One screen at a time. Each of them brings its OWN <h1> — that is what
   * `OnboardingFrame` moves focus to when the step changes — and each takes its
   * answer and its handlers as props, so none of them touches the router.
   */
  function renderScreen() {
    switch (current) {
      case "welcome":
        return (
          <WelcomeScreen
            // `/api/me` has `account.displayName`, nullable, and no email at
            // all — see PENDING(welcome-name) inside `WelcomeScreen`. A blank
            // name is the same as no name: it must not render "Chào  👋".
            name={displayName}
            onStart={advance}
          />
        );
      case "seller":
        return (
          <StepSeller
            value={sellerKind}
            onChange={setSellerKind}
            onContinue={advance}
            onSkip={skip}
          />
        );
      case "tools":
        return (
          <StepTools
            values={currentTools}
            onToggle={toggleTool}
            onContinue={advance}
            onSkip={skip}
          />
        );
      case "count":
        return (
          <StepCount
            value={channelCount}
            onChange={setChannelCount}
            onContinue={advance}
            onSkip={skip}
          />
        );
      case "channels":
        return (
          <StepChannels
            values={focusChannels}
            onToggle={toggleChannel}
            onContinue={advance}
            onSkip={skip}
          />
        );
    }
  }

  const content = (
    <OnboardingFrame
      screen={current}
      // The greeting has nothing behind it to go back to.
      onBack={current === "welcome" ? undefined : goBack}
    >
      {renderScreen()}
    </OnboardingFrame>
  );

  /**
   * THE SAME THREE PROVIDERS `AppFrame` wraps the app in, for the same reason
   * `SignInScreen` repeats them: this route group sits OUTSIDE `(app)`, so
   * nothing above it mounts them.
   *
   * Without `<Theme>` every Astryx component rendered here — `ColorSchemeToggle`
   * in the header, the option cards the later tasks add — falls back to
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
        <Theme theme={myspTheme}>
          {content}
          {/* The flow's own way out, kept for accounts that signed in with the
              wrong Google account: this route has no top bar to sign out from. */}
          {signOutAction && current === "welcome" ? (
            <form action={signOutAction} className="fixed inset-x-0 bottom-6 z-20 text-center">
              <button
                type="submit"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-6 items-center rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
              >
                Đăng xuất
              </button>
            </form>
          ) : null}
        </Theme>
      </InternationalizationProvider>
    </LinkProvider>
  );
}

/*
 * The stand-in screen and its table of headings lived here until task 8. Both
 * are gone on purpose: every question now owns its own wording, next to the
 * options that wording belongs with, and a second copy of a question is a
 * second thing to reword.
 */
