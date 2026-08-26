"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/ui/components/ui/button";

import type { OnboardingSlideId } from "./onboarding-steps";

/**
 * The frame every slide sits in: one <h1>, the motion, the escape routes.
 *
 * FOCUS: changing slide is a navigation, so focus moves to the new heading.
 * Without it a keyboard or screen-reader user is left on a button that no
 * longer exists and hears nothing about what replaced it.
 *
 * MOTION: only `transform` and `opacity` — nothing that forces layout. Exit is
 * shorter than enter (200ms vs 320ms) so backing out feels immediate. Under
 * `prefers-reduced-motion` the whole thing collapses to a short crossfade.
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
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prefersReduced = useReducedMotion();

  useEffect(() => {
    headingRef.current?.focus();
  }, [id]);

  const offset = prefersReduced ? 0 : 24 * direction;

  return (
    <motion.section
      key={id}
      initial={{ opacity: 0, x: offset }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -offset }}
      transition={{
        duration: prefersReduced ? 0.12 : 0.32,
        // Exit at ~60% of enter: leaving should feel faster than arriving.
        ease: [0.16, 1, 0.3, 1],
      }}
      className="mx-auto flex w-full max-w-2xl flex-col gap-6"
    >
      <header className="flex flex-col gap-2">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-2xl font-semibold outline-none"
        >
          {heading}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">{lead}</p>
      </header>

      {children}

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
        {exitHref ? (
          <Link
            href={exitHref}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2"
          >
            Vào ứng dụng
          </Link>
        ) : null}
      </footer>
    </motion.section>
  );
}
