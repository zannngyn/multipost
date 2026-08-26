"use client";

import { LinkProvider, Theme } from "@astryxdesign/core";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useSetupProgress } from "@/ui/hooks/useSetupProgress";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import { AppLink } from "@/ui/components/shell/AppLink";
import { myspTheme } from "@/ui/theme/mysp";

import { SlideCompany } from "./SlideCompany";
import { SlideShell } from "./SlideShell";
import {
  ONBOARDING_SLIDE_IDS,
  SLIDE_TITLES,
  nextSlide,
  previousSlide,
  resolveSlide,
  type OnboardingSlideId,
} from "./onboarding-steps";
import { usePassedSlides } from "./usePassedSlides";

/**
 * The slideshow itself.
 *
 * It holds no idea of "which step am I on". The URL carries an intent, the six
 * server flags carry the truth, `resolveSlide` reconciles them — which is what
 * lets slide 02 and 03 send the browser to an OAuth provider and still come
 * back to the right place.
 */
export function OnboardingFlow({
  // Slide 01 is the only one that shows it, and `src/ui` may not import
  // `src/app`, so the Server Action arrives as a prop.
  signOutAction,
}: {
  signOutAction?: () => Promise<void>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isResolved, role } = useActiveTenant();
  const progress = useSetupProgress();
  const { passed, markPassed } = usePassedSlides();

  // --- Edge case: this flow is not for every role --------------------------
  // `useSetupProgress` is gated to owner/admin and the endpoint answers 403 to
  // anyone else, so an editor who types the URL would get `progress.data ===
  // undefined` — which reads exactly like "no company yet" and would put a
  // CREATE COMPANY form in front of somebody who already belongs to one.
  // The role check has to happen before the position is derived, not after.
  const isAllowedRole = role === "owner" || role === "admin";
  useEffect(() => {
    if (isResolved && !isAllowedRole) router.replace("/");
  }, [isResolved, isAllowedRole, router]);

  // Which way the next slide should enter. State, not a ref: the value is READ
  // WHILE RENDERING to pick the animation, and a ref read during render is both
  // a lint error here and a value React makes no promise about. The extra
  // render rides along with the navigation `goTo` is about to trigger anyway.
  const [direction, setDirection] = useState<1 | -1>(1);

  // --- Edge case: the flags are still in flight ----------------------------
  // Same trap as above, one beat earlier: on first paint `progress.data` is
  // undefined for a tenant that IS fully set up. Deriving a slide from that
  // flashes the create-company form before the real answer arrives.
  const isAwaitingFlags = isResolved && isAllowedRole && progress.isPending && !progress.data;

  const current = resolveSlide({
    // No tenant yet => no flags exist; slide 01 is the only possible answer.
    progress: isResolved ? (progress.data ?? null) : null,
    requested: searchParams.get("step"),
    passed,
  });

  const goTo = useCallback(
    (target: OnboardingSlideId, way: 1 | -1) => {
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
    goTo(nextSlide(current), 1);
  }, [current, goTo, markPassed]);

  const goBack = useCallback(() => {
    const target = previousSlide(current);
    if (target) goTo(target, -1);
  }, [current, goTo]);

  if (isResolved && !isAllowedRole) return null;

  // Nothing rather than a skeleton: the wait is a cache read in the common case,
  // and a frame of the wrong slide is worse than a frame of nothing.
  if (isAwaitingFlags) return null;

  // --- Edge case: the flags themselves failed to load -----------------------
  // Guessing a slide here would put the operator in front of controls whose
  // prerequisites are unknown. Say so and offer the retry instead.
  const content =
    isResolved && progress.isError && !progress.data ? (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 sm:p-10">
        <h1 className="text-foreground text-2xl font-semibold">Chưa đọc được tiến độ thiết lập</h1>
        <ApiErrorNotice error={progress.error} onRetry={() => void progress.refetch()} />
      </div>
    ) : (
      /* ONE shell for the whole flow, NOT one per slide: the story column has
         to survive the change of slide, or the heading and the rail would slide
         out and back in on every step. `SlideShell` keys the travelling half on
         `id` internally. */
      <SlideShell
        id={current}
        direction={direction}
        heading={SLIDE_TITLES[current]}
        lead={LEADS[current]}
        onSkip={current === "company" || current === "congrats" ? undefined : advance}
        onBack={current === "company" ? undefined : goBack}
        exitHref={current === "company" ? undefined : "/"}
        // Only slide 01 needs it: from slide 02 on there is a company, so
        // "Vào ứng dụng" is the sane way out and sign-out lives in the app.
        signOutAction={current === "company" ? signOutAction : undefined}
      >
        {/* Tasks 06-10 replace the remaining five placeholders. */}
        {current === "company" ? (
          <SlideCompany
            // Creating the company advances the flow only from the mutation's
            // `onSuccess`; a failed create must not move on.
            onCreated={advance}
            // Someone who accepted an invite joined a company somebody else
            // set up — the remaining five slides are not theirs to do, so they
            // go straight into the app.
            onJoined={() => router.replace("/")}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Nội dung màn này được lắp ở task sau ({current}).
          </p>
        )}
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

const LEADS: Record<OnboardingSlideId, string> = {
  company: "Dữ liệu trong MYSP luôn thuộc về một công ty. Tạo công ty là bước duy nhất bắt buộc.",
  data: "Cho MYSP đọc kho ảnh trong Drive và bảng sản phẩm trong Google Sheet của bạn.",
  facebook: "Nối fanpage sẽ nhận bài đăng. Nối được nhiều trang cùng lúc.",
  group: "Gom các trang hay đăng cùng nhau để sau này chọn một lần.",
  invite: "Gửi link cho người sẽ đăng bài cùng bạn. Mời sau cũng được.",
  congrats: "Thiết lập xong. Bắt đầu bài đăng đầu tiên thôi.",
};

/** Referenced so an unused-import lint never hides a missing slide. */
void ONBOARDING_SLIDE_IDS;
