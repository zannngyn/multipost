"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/ui/components/ui/button";

import { ProgressRail } from "./ProgressRail";
import { ONBOARDING_SLIDE_IDS, slideOrdinal, type OnboardingSlideId } from "./onboarding-steps";

/**
 * The frame every slide sits in: STORY on the left, ACTION on the right.
 *
 * WHY TWO COLUMNS. The first build centred one 672px column in a 1710px window,
 * which left ~180px of dead band above it, gave the progress strip a different
 * left edge from the heading, and printed the slide title twice. Splitting the
 * screen fixes all three at once — but the real reason it is the right shape is
 * MOTION: the story column never unmounts, so the ground stays still and only
 * the controls travel. Sliding the whole screen, heading and all, would make
 * every step feel like a page load.
 *
 * That is also why `AnimatePresence` lives INSIDE this component and is keyed
 * on the content, not on the shell. `OnboardingFlow` renders one `SlideShell`
 * for the whole flow; only `children` swap.
 *
 * FOCUS: changing slide is a navigation, so focus moves to the new heading —
 * which is in the story column. Without it a keyboard or screen-reader user is
 * left on a button that no longer exists and hears nothing about what replaced
 * it.
 *
 * MOTION: only `transform` and `opacity`, nothing that forces layout. Enter
 * 320ms, exit 200ms — leaving should feel faster than arriving. Under
 * `prefers-reduced-motion` both collapse to a 120ms crossfade with no travel.
 *
 * LANDMARK: the whole frame is `<main>`. This route renders outside
 * `AppFrame`, so nothing above it provides one, and the flow's only <h1> must
 * not sit in a complementary landmark such as `<aside>`.
 *
 * COLOUR: every string below declares its own, none inherits. Astryx's
 * `<Theme>` scopes `--color-text-primary` onto the text under it, and that is
 * the same near-black a raised surface can use as its background (spec §10) —
 * the bug `WizardRail` shipped once already.
 */
export function SlideShell({
  id,
  heading,
  lead,
  children,
  direction,
  onSkip,
  skipLabel = "Để sau",
  onBack,
  exitHref,
  signOutAction,
}: {
  id: OnboardingSlideId;
  heading: string;
  lead: string;
  children: ReactNode;
  /** 1 = moving forward, -1 = moving back. Drives which way the slide enters. */
  direction: 1 | -1;
  /** Absent on the mandatory first slide and on congrats. */
  onSkip?: () => void;
  skipLabel?: string;
  onBack?: () => void;
  /** "Vào ứng dụng". Absent on slide 01 — there is no app to enter yet. */
  exitHref?: string;
  /**
   * Sign-out, from the page — `src/ui` may not import `src/app`. Only slide 01
   * shows it: this route has no top bar, so without it an account that belongs
   * to no company is stuck in the browser with no way back to /signin.
   */
  signOutAction?: () => Promise<void>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prefersReduced = useReducedMotion();

  useEffect(() => {
    headingRef.current?.focus();
  }, [id]);

  const travel = prefersReduced ? 0 : 24 * direction;
  const enterDuration = prefersReduced ? 0.12 : 0.32;
  const exitDuration = prefersReduced ? 0.12 : 0.2;
  const ordinal = String(slideOrdinal(id)).padStart(2, "0");

  return (
    <main className="grid min-h-dvh grid-cols-1 md:grid-cols-[minmax(19rem,32%)_1fr]">
      {/* ── STORY ── persistent across slides; only the words change. ─────── */}
      <div className="bg-card border-border flex flex-col gap-6 border-b p-6 sm:p-8 md:min-h-dvh md:gap-8 md:border-r md:border-b-0 md:p-10">
        {/* Decoration, not information: `ProgressRail` below already says
            "Bước n/6" in words, and repeating it here would make a screen
            reader announce the position twice. */}
        <div aria-hidden="true" className="flex items-center gap-3">
          <span className="text-foreground-subtle font-mono text-xs tracking-widest tabular-nums">
            {ordinal}
          </span>
          <span className="bg-muted block h-px flex-1 overflow-hidden rounded-full">
            <span
              className="bg-primary block h-px w-full origin-left motion-safe:transition-transform motion-safe:duration-300"
              style={{ transform: `scaleX(${slideOrdinal(id) / ONBOARDING_SLIDE_IDS.length})` }}
            />
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-card-foreground text-2xl leading-tight font-semibold outline-none sm:text-3xl"
          >
            {heading}
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">{lead}</p>
        </div>

        {/* `mt-auto` only once the column is full height, i.e. from `md` up.
            Stacked on a phone the story is a band, and pinning the rail to the
            bottom of a band just adds a gap. */}
        <div className="flex flex-col gap-4 md:mt-auto">
          <ProgressRail current={id} />

          {(exitHref ?? signOutAction) ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {exitHref ? (
                <Link
                  href={exitHref}
                  className="text-muted-foreground hover:text-card-foreground focus-visible:ring-ring inline-flex min-h-6 items-center rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
                >
                  Vào ứng dụng
                </Link>
              ) : null}

              {signOutAction ? (
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="text-muted-foreground hover:text-card-foreground focus-visible:ring-ring inline-flex min-h-6 items-center rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
                  >
                    Đăng xuất
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── ACTION ── the only part that travels. ──────────────────────────── */}
      {/* Top-aligned, not centred: centring is what produced the ~180px dead
          band above the form and ~100px below it. Sharing a top edge with the
          story column also gives the two columns one optical baseline. */}
      <div className="flex min-h-0 flex-col items-center p-6 sm:p-8 md:p-10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={id}
            initial={{ opacity: 0, x: travel }}
            animate={{
              opacity: 1,
              x: 0,
              transition: { duration: enterDuration, ease: [0.16, 1, 0.3, 1] },
            }}
            exit={{
              opacity: 0,
              x: -travel,
              transition: { duration: exitDuration, ease: [0.16, 1, 0.3, 1] },
            }}
            className="mx-auto flex w-full max-w-xl flex-col gap-6"
          >
            {children}

            {(onBack ?? onSkip) ? (
              <footer className="flex flex-wrap items-center gap-3">
                {onBack ? (
                  <Button type="button" variant="ghost" onClick={onBack}>
                    Quay lại
                  </Button>
                ) : null}
                {onSkip ? (
                  <Button type="button" variant="ghost" onClick={onSkip}>
                    {skipLabel}
                  </Button>
                ) : null}
              </footer>
            ) : null}
          </motion.section>
        </AnimatePresence>
      </div>
    </main>
  );
}
