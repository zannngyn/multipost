import { ArrowRight } from "lucide-react";

import { Button } from "@/ui/components/ui/button";

import "./backdrop-motion.css";
import {
  ENTER_DELAY_CARDS,
  ENTER_DELAY_HEADING,
  enterDelay,
} from "./onboarding-motion";
import "./onboarding-motion.css";

/**
 * WHEN THE GREETING AND ITS BUTTON ARRIVE.
 *
 * They ride the SAME timeline as the four questions (animation spec section 4),
 * not a private one: the heading takes row 4 at 100ms, the button takes the
 * slot where the first card would be at 260ms, and both use the shapes and the
 * token-mapped durations of `onboarding-motion.css`. It finishes at 785ms, well
 * inside the 1.2s ceiling section 2 puts on entering a screen.
 *
 * WHY THE BUTTON TAKES A CARD'S SLOT AND NOT THE CTA'S. The CTA slot is 635ms
 * because six cards come before it; this screen has no cards, so the slot is
 * empty and putting the button there would be waiting for a queue that does not
 * exist. It also keeps the earlier finding intact: the backdrop's outermost
 * marks are still arriving at ~725ms, and parking the only way forward behind
 * them would leave the primary action invisible for most of a second.
 *
 * The whole thing is switched off under `prefers-reduced-motion: reduce` by the
 * stylesheets, which is why there is no hook here.
 */

/**
 * The greeting. One heading, one way forward, nothing to skip and nothing to go
 * back to (spec section 4).
 *
 * A PURE component: the name and the handler arrive as props, so it renders
 * without a router, without `/api/me`, and — the reason it matters here — under
 * `renderToStaticMarkup` in a test suite that has no DOM.
 */
export function WelcomeScreen({
  /** Null when the account has no display name on file. */
  name,
  onStart,
}: {
  name: string | null;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-8">
      {/*
        28px / 35px, measured (spec section 2.3). Neither lands on the type
        scale, and the visual gate measures both, so they are stated outright.
        `font-heading` keeps it on Astryx's heading family — Buffer's Stolzl is
        a paid font and is NOT what MYSP renders (spec section 10).

        `tabIndex={-1}`: changing screen is a navigation, so `OnboardingFrame`
        moves focus here. Without it a keyboard user is left on a button that
        has just been unmounted.
      */}
      <h1
        tabIndex={-1}
        style={enterDelay(ENTER_DELAY_HEADING)}
        className="onboarding-enter text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        {/*
          PENDING(welcome-name): spec section 12 asks for the local part of the
          email when there is no display name, but `/api/me` carries NO email
          field at all (`MeResponseSchema`) — only `account.displayName`, which
          is nullable. So a nameless account gets a greeting with no name rather
          than an invented one.
        */}
        <span className="block">
          {name === null ? "Chào bạn 👋" : `Chào ${name} 👋`}
        </span>
        <span className="block">Chào mừng tới MYSP</span>
      </h1>

      {/*
        48px tall, 12px corners, 0 24px of padding — measured (spec 2.4), and
        every one of them past what the local `Button` scale reaches, which tops
        out at 36px. `rounded-lg` IS `--radius` (16px), the prototype's corner.

        INK, NOT THE DYE, like the CTA on every question — this is the same
        primary action and it may not be a different colour from the four
        screens after it. `--foreground`/`--background`, so the dark theme
        inverts it correctly.

        It HUGS its label (~139px measured) instead of stretching: no `w-full`
        here, and the column above centres rather than stretches it.
      */}
      {/*
        THE ENTRANCE RIDES A WRAPPER, like every other call site. This one was
        the last holdout: `buttonVariants` puts `disabled:opacity-50`,
        `active:…translate-y-px` and `transition-all` on the element itself, and
        a running keyframe outranks all three for as long as it runs. It has
        never actually broken — this button is never `disabled` — but "the one
        place we did it the old way" is how the bug comes back, and the guard in
        `option-card-render.test.tsx` now watches this screen too.
      */}
      <div style={enterDelay(ENTER_DELAY_CARDS)} className="onboarding-enter">
        <Button
          type="button"
          onClick={onStart}
          className="bg-foreground text-background hover:bg-foreground/90 h-12 gap-2 rounded-lg px-6 text-sm font-medium"
        >
          Bắt đầu
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
