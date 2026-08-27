"use client";

import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Variants } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/shared/utils";
import { ColorSchemeToggle } from "@/ui/components/shell/ColorSchemeToggle";
import { Button } from "@/ui/components/ui/button";

import { GridBackdrop } from "./GridBackdrop";
import { StepDots } from "./StepDots";
import {
  ENTER_DELAY_BRAND,
  ENTER_DELAY_DOTS,
  ENTER_DELAY_THEME,
  enterDelay,
} from "./onboarding-motion";
import "./onboarding-motion.css";
import type { OnboardingScreen } from "./onboarding-steps";

/**
 * THE SCREEN CHANGE's timing — the backdrop has its own, further down.
 *
 * Mapped onto this project's duration scale rather
 * than typed from the animation spec (section 6 asks for 380ms in and 320ms
 * out): `--duration-medium-max` is 400ms and `--duration-medium` is 300ms in
 * `src/ui/theme/mysp.css`. `--ease-standard` is the system's ONLY curve, and an
 * entrance must not overshoot (spec section 9), so both directions read it.
 *
 * THE RULE THAT SURVIVES THE MAPPING is section 6's own: the old screen has to
 * leave FASTER than the new one arrives, or the flow feels like going backwards.
 * 300 < 400, and both sit inside the 300-400ms band section 2 gives a screen
 * change. The full mapping table lives in `onboarding-motion.css`.
 *
 * THE VALUES ARE THIS PROJECT'S, NOT THE LIBRARY'S. `mysp.css` is generated and
 * `pnpm theme:check` guards it; it re-values Astryx's whole duration scale
 * faster than `@astryxdesign/core` ships it. framer-motion takes numbers, not
 * `var()`, so the resolved values are written out here; anything CSS can
 * express reads the token instead (see `onboarding-motion.css`). If the theme
 * moves, these move with it.
 *
 * Seconds, because that is the unit framer-motion reads.
 */
const ENTER_DURATION = 0.4;
const EXIT_DURATION = 0.3;
const EASE_STANDARD = [0.24, 1, 0.4, 1] as const;

/**
 * THE BACKDROP'S OWN CLOCK, which is NOT the screen change's.
 *
 * The ruled ground behind the greeting crossfades in and out; it does not
 * travel, and it is not what the spec's section 6 is about. It kept these three
 * values from before the slide existed — `--duration-medium-min` in,
 * `--duration-fast` out, `--duration-fast-min` under reduced motion — and it
 * should keep them.
 *
 * THEY WERE BRIEFLY SHARED, AND THAT WAS A REGRESSION, not a decision. When the
 * crossfade became a slide, the two screen constants were re-valued from
 * 0.225/0.125 to 0.4/0.3 and the backdrop was still reading them, so it silently
 * slowed by ~78% in and 140% out; `REDUCED_DURATION` was dropped at the same
 * time, which left a reduced-motion visitor on `0` instead of 0.095. Nobody
 * asked for either. Separate names now, so re-timing the screens cannot re-time
 * the ground under them again.
 *
 * Seconds, because that is the unit framer-motion reads. Resolved by hand for
 * the same reason as above, and guarded against the theme by
 * `onboarding-motion.test.ts`.
 */
const BACKDROP_ENTER_DURATION = 0.225;
const BACKDROP_EXIT_DURATION = 0.125;
const BACKDROP_REDUCED_DURATION = 0.095;

/** How far a screen travels sideways (spec section 3, `--dist-slide`). Far
 *  enough to read as a direction, short enough not to look like a page turn. */
const SLIDE_DISTANCE_PX = 56;

/**
 * Which way the flow is moving, as a sign: +1 going forward, -1 going back.
 * Forward means the arriving screen comes from the RIGHT and the leaving one
 * goes LEFT; back is the mirror of that (spec section 6, last line).
 */
export type FlowDirection = 1 | -1;

/**
 * `custom` is how framer-motion gets a value to a child that is already on its
 * way out: a leaving child's props are frozen at the moment it was removed, so
 * an `exit` object built from `direction` during that render would carry the
 * direction the flow had BEFORE the change. `AnimatePresence`'s own `custom`
 * prop is read at exit time instead, which is the only way back travels back.
 */
const SCREEN_VARIANTS: Variants = {
  arriving: (direction: FlowDirection) => ({
    opacity: 0,
    x: direction * SLIDE_DISTANCE_PX,
  }),
  settled: {
    opacity: 1,
    x: 0,
    transition: { duration: ENTER_DURATION, ease: EASE_STANDARD },
  },
  leaving: (direction: FlowDirection) => ({
    opacity: 0,
    x: direction * -SLIDE_DISTANCE_PX,
    transition: { duration: EXIT_DURATION, ease: EASE_STANDARD },
  }),
};

/**
 * The same three states with the travel and the clock taken out, for a visitor
 * who asked for less motion. Not "faster" — nothing moves and nothing takes
 * time, so the screen simply changes. Section 7 of the spec asks for exactly
 * that, and it is the shape the stylesheets in this folder already use.
 */
const STILL_VARIANTS: Variants = {
  arriving: { opacity: 0, x: 0 },
  settled: { opacity: 1, x: 0, transition: { duration: 0 } },
  leaving: { opacity: 0, x: 0, transition: { duration: 0 } },
};

/**
 * The frame every screen of the flow sits in (spec section 3).
 *
 * ONE CENTRED COLUMN, not the two columns the setup slideshow used. Buffer puts
 * the back arrow and the wordmark in the top-left, the position dots at the top
 * centre and the light/dark control top-right.
 *
 * THE TWO HALVES DO NOT SIT AT THE SAME HEIGHT, and that is measured, not
 * taste. In the reference shots at 1400x867 the greeting's block centres on
 * y≈279 while every survey step centres on y≈460 — the greeting sits about a
 * third of the way down, the questions sit in the middle. An earlier draft of
 * the spec said "everything centred"; the images say otherwise.
 *
 * THE TRANSITION IS A HORIZONTAL SLIDE (animation spec section 6). The old
 * screen leaves to the left while fading, and only once it is gone does the new
 * one arrive from the right — `mode="wait"`, which is what makes it a sequence
 * rather than a dissolve. Going BACK mirrors it. This replaces the crossfade
 * that used to live here, read off the reference shot
 * `05-step-transition-crossfade.jpg`; the PM chose the spec's travel over the
 * shot's overlap on 26/08/2026, and the two cannot both be true because a
 * crossfade needs the screens on top of each other and a slide needs them one
 * after the other.
 *
 * THE TOP BAR DOES NOT MOVE WITH THEM. It is outside the presence group and
 * mounts once, so its own entrance (spec section 4, rows 1-3) plays on arrival
 * at the flow and never again — which is section 6's "bỏ delay topbar" for
 * every step change after the first, without a flag to get wrong.
 *
 * FOCUS: changing screen is a navigation, so focus moves to the new heading.
 * That job belongs to `ScreenLayer` — see the note there; doing it from here
 * was a real bug under `mode="wait"`.
 */
export function OnboardingFrame({
  screen,
  /**
   * Which way the flow just moved. Decided by `OnboardingFlow`, because the
   * frame only ever sees the destination and a screen change on its own does
   * not say whether it was a step forward or the back arrow.
   */
  direction = 1,
  /** Absent on the welcome screen: there is nothing behind it to go back to. */
  onBack,
  children,
}: {
  screen: OnboardingScreen;
  direction?: FlowDirection;
  onBack?: () => void;
  children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  const isStill = prefersReducedMotion === true;

  // The backdrop only. The screens read `SCREEN_VARIANTS`/`STILL_VARIANTS`.
  const backdropEnterDuration = isStill
    ? BACKDROP_REDUCED_DURATION
    : BACKDROP_ENTER_DURATION;
  const backdropExitDuration = isStill
    ? BACKDROP_REDUCED_DURATION
    : BACKDROP_EXIT_DURATION;
  const isWelcome = screen === "welcome";

  return (
    <main className="text-foreground relative min-h-dvh overflow-hidden">
      {/* The ruled ground belongs to the GREETING only — the four question
          screens stand on plain cloth in the reference shots. It fades with the
          screen it belongs to rather than vanishing under it. */}
      <AnimatePresence initial={false}>
        {isWelcome ? (
          <motion.div
            key="backdrop"
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: {
                duration: backdropEnterDuration,
                ease: EASE_STANDARD,
              },
            }}
            exit={{
              opacity: 0,
              transition: {
                duration: backdropExitDuration,
                ease: EASE_STANDARD,
              },
            }}
          >
            <GridBackdrop />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/*
        Floated over the stage rather than stacked above it, so the content
        below is positioned against the WINDOW and not against the space the
        header leaves behind. Three tracks with the dots in the middle one: that
        is what keeps them on the window's centre line however wide the two
        sides grow.
      */}
      <header className="absolute inset-x-0 top-0 z-20 grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-8 py-7">
        {/* Row 1 of the entrance table: the head of the timeline, at 0ms. */}
        <div
          style={enterDelay(ENTER_DELAY_BRAND)}
          className="onboarding-enter-drop flex items-center gap-2 justify-self-start"
        >
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onBack}
              aria-label="Quay lại bước trước"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <span className="text-foreground font-heading text-lg leading-none font-bold">
            MYSP
          </span>
        </div>

        {/* The wrapper stays even when `StepDots` draws nothing on the greeting.
            Without it the middle track has no item, the light/dark control
            slides into the centre column, and the whole right-hand side of the
            header moves to the middle of the window.

            It also carries row 2 of the entrance table (80ms). The wrapper and
            not `StepDots` itself, because the wrapper is the thing that is here
            from the first frame — the dots appear later, on the first question,
            and an entrance that replayed there would announce them twice. */}
        <div
          style={enterDelay(ENTER_DELAY_DOTS)}
          className="onboarding-enter-drop justify-self-center"
        >
          <StepDots current={screen} />
        </div>

        {/* THE app's light/dark control, imported, not rebuilt (spec 12): it
            owns the cookie and the `dark` class on <html>, and a second switch
            would be a second source of truth for one preference.

            Row 3 of the entrance table (120ms), and a fade with no travel — it
            is the least important thing on the bar. */}
        <div
          style={enterDelay(ENTER_DELAY_THEME)}
          className="onboarding-enter-fade justify-self-end"
        >
          <ColorSchemeToggle />
        </div>
      </header>

      <div className="relative z-10 grid min-h-dvh px-6">
        {/*
          `mode="wait"` — the leaving screen finishes before the arriving one
          starts, which is what section 6 describes and what makes the exit and
          the entrance read as one movement instead of two overlapping ones.
          `initial={false}` keeps the FIRST screen from sliding in: arriving at
          the flow is not a step change, and that screen has its own entrance
          choreography to play (spec section 4).
        */}
        <AnimatePresence initial={false} mode="wait" custom={direction}>
          <motion.div
            key={screen}
            custom={direction}
            variants={isStill ? STILL_VARIANTS : SCREEN_VARIANTS}
            initial="arriving"
            animate="settled"
            exit="leaving"
            className={cn(
              "w-full max-w-[1110px] justify-self-center",
              /* 23.5dvh puts the block's centre on y≈279 at 1400x867, the
                 measured position of the greeting. A share of the window, not a
                 pixel count, so it holds its proportion on a taller screen. */
              isWelcome
                ? "self-start pt-[23.5dvh] pb-16"
                : /* THE QUESTIONS ARE NOT ON THE WINDOW'S CENTRE LINE. Both
                     reference shots put the block — top of the heading to the
                     foot of "Bỏ qua" — on y≈459.5 of 867, i.e. 53.0%, and they
                     agree on it despite being 15px apart in height, so it is a
                     property of the frame and not of the content. Plain
                     centring lands on 50% (measured: 429.5); the surplus 6.9dvh
                     of top padding moves the centre down by half of itself,
                     which is the missing 3%. A share of the window rather than
                     a pixel count, because vertical position is compared by
                     ratio (spec section 0b). */
                  "self-center pt-[calc(7rem+6.9dvh)] pb-28",
            )}
          >
            <ScreenLayer screen={screen}>{children}</ScreenLayer>
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  );
}

/**
 * One screen's own layer.
 *
 * IT MOVES THE FOCUS, AND THAT IS NOT AN ARBITRARY PLACE TO DO IT. Changing
 * screen is a navigation, so focus belongs on the arriving heading
 * (`web-accessibility` section 3). The frame used to do it from an effect on
 * `screen` — which worked while the two screens overlapped, and became a silent
 * no-op the moment the transition became `mode="wait"`: when `screen` changes,
 * the arriving screen has NOT mounted yet, so there is no heading in the
 * document to find. Here the effect runs on the layer's own mount, which is by
 * definition the first moment its heading exists.
 *
 * The heading belongs to `children` — each screen owns its own <h1> — so the
 * layer finds it rather than holding a ref into somebody else's markup.
 *
 * IT ALSO TAKES ITSELF OUT OF REACH WHILE IT LEAVES. `useIsPresent` is false
 * exactly while a layer is animating out, and a layer that is still painted is
 * still tabbable: without `inert` a keyboard or screen-reader user could land
 * in the screen that is on its way off the side.
 *
 * Separate component because both hooks have to run INSIDE what
 * `AnimatePresence` wraps; called in `OnboardingFrame` they would answer for
 * the frame, which never leaves.
 */
function ScreenLayer({
  screen,
  children,
}: {
  screen: OnboardingScreen;
  children: ReactNode;
}) {
  const isPresent = useIsPresent();
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const heading = layerRef.current?.querySelector("h1");
    // --- Edge case first: a screen with no <h1> would leave focus on <body>.
    // Nothing in this flow is built that way, and if one ever is, losing focus
    // silently is worse than the layer keeping it.
    if (heading instanceof HTMLElement) heading.focus();
    else layerRef.current?.focus();
  }, []);

  return (
    <div
      ref={layerRef}
      // Focusable only as the fallback above, never by tabbing to it.
      tabIndex={-1}
      data-onboarding-screen={screen}
      aria-hidden={isPresent ? undefined : true}
      inert={!isPresent}
      className="flex flex-col items-center outline-none"
    >
      {children}
    </div>
  );
}
