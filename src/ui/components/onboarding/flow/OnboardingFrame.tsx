"use client";

import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/shared/utils";
import { ColorSchemeToggle } from "@/ui/components/shell/ColorSchemeToggle";
import { Button } from "@/ui/components/ui/button";

import { GridBackdrop } from "./GridBackdrop";
import { StepDots } from "./StepDots";
import type { OnboardingScreen } from "./onboarding-steps";

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
 * THE TRANSITION IS A CROSSFADE, NOT A SLIDE. Caught mid-change in the
 * reference shot `05-step-transition-crossfade.jpg`: the two screens overlap,
 * share a centre, and one fades out as the other fades in — there is no
 * horizontal travel at all. That is why both children are parked in the SAME
 * grid cell and `AnimatePresence` runs in its default overlapping mode; `mode`
 * "wait" would play them one after the other and lose the overlap. Durations
 * are the project's own (in 320ms, out 200ms, 120ms under reduced motion), only
 * the manner is Buffer's.
 *
 * FOCUS: changing screen is a navigation, so focus moves to the new heading.
 * The heading belongs to `children` — each screen owns its own <h1> — so the
 * frame finds it rather than holding a ref into somebody else's markup, and it
 * looks for it INSIDE the arriving layer: during the crossfade the leaving
 * screen still has its own <h1> in the document.
 */
export function OnboardingFrame({
  screen,
  /** Absent on the welcome screen: there is nothing behind it to go back to. */
  onBack,
  children,
}: {
  screen: OnboardingScreen;
  onBack?: () => void;
  children: ReactNode;
}) {
  const prefersReduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const arriving = stageRef.current?.querySelector(`[data-onboarding-screen="${screen}"] h1`);
    if (arriving instanceof HTMLElement) arriving.focus();
  }, [screen]);

  const enterDuration = prefersReduced ? 0.12 : 0.32;
  const exitDuration = prefersReduced ? 0.12 : 0.2;
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
            animate={{ opacity: 1, transition: { duration: enterDuration, ease: "easeOut" } }}
            exit={{ opacity: 0, transition: { duration: exitDuration, ease: "easeOut" } }}
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
        <div className="flex items-center gap-2 justify-self-start">
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
          <span className="text-foreground font-heading text-lg leading-none font-bold">MYSP</span>
        </div>

        {/* The wrapper stays even when `StepDots` draws nothing on the greeting.
            Without it the middle track has no item, the light/dark control
            slides into the centre column, and the whole right-hand side of the
            header moves to the middle of the window. */}
        <div className="justify-self-center">
          <StepDots current={screen} />
        </div>

        {/* THE app's light/dark control, imported, not rebuilt (spec 12): it
            owns the cookie and the `dark` class on <html>, and a second switch
            would be a second source of truth for one preference. */}
        <div className="justify-self-end">
          <ColorSchemeToggle />
        </div>
      </header>

      <div ref={stageRef} className="relative z-10 grid min-h-dvh px-6">
        <AnimatePresence initial={false}>
          <motion.div
            key={screen}
            // Same cell as the outgoing screen: that overlap IS the crossfade.
            style={{ gridArea: "1 / 1" }}
            className={cn(
              "w-full max-w-[1110px] justify-self-center",
              /* 23.5dvh puts the block's centre on y≈279 at 1400x867, the
                 measured position of the greeting. A share of the window, not a
                 pixel count, so it holds its proportion on a taller screen. */
              isWelcome ? "self-start pt-[23.5dvh] pb-16" : "self-center py-28",
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: enterDuration, ease: "easeOut" } }}
            exit={{ opacity: 0, transition: { duration: exitDuration, ease: "easeOut" } }}
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
 * It exists for the 200ms in which TWO screens are in the document: without it
 * the page would carry two <h1>s and two sets of focusable controls, and a
 * keyboard or screen-reader user could land in the screen that is on its way
 * out. `useIsPresent` is false exactly while a layer is leaving, so the leaving
 * one is taken out of the accessibility tree and out of the tab order for as
 * long as it is still painted.
 *
 * Separate component because the hook has to run INSIDE what `AnimatePresence`
 * wraps; called in `OnboardingFrame` it would always answer `true`.
 */
function ScreenLayer({ screen, children }: { screen: OnboardingScreen; children: ReactNode }) {
  const isPresent = useIsPresent();

  return (
    <div
      data-onboarding-screen={screen}
      aria-hidden={isPresent ? undefined : true}
      inert={!isPresent}
      className="flex flex-col items-center"
    >
      {children}
    </div>
  );
}
