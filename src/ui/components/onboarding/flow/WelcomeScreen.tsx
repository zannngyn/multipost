import { ArrowRight } from "lucide-react";
import type { CSSProperties } from "react";

import { Button } from "@/ui/components/ui/button";

import "./backdrop-motion.css";

/**
 * When the greeting and its button arrive, relative to the backdrop's marks
 * (spec 4b: the copy comes in last).
 *
 * MULTIPLES OF A TOKEN, not typed numbers: `--duration-fast` is 125ms in this
 * project's theme, so the heading starts at ~188ms and the button at 250ms.
 * Deliberately NOT behind the outermost marks, which are still arriving at
 * ~725ms — Astryx's motion guidance is that motion must never stand between the
 * user and their next action, and a primary action invisible for most of a
 * second does exactly that. The whole thing is switched off under
 * `prefers-reduced-motion: reduce` by the stylesheet, which is why there is no
 * hook here.
 */
const HEADING_DELAY = { "--late-in-delay": "calc(var(--duration-fast) * 1.5)" } as CSSProperties;
const BUTTON_DELAY = { "--late-in-delay": "calc(var(--duration-fast) * 2)" } as CSSProperties;

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
        style={HEADING_DELAY}
        className="onboarding-late-in text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        {/*
          PENDING(welcome-name): spec section 12 asks for the local part of the
          email when there is no display name, but `/api/me` carries NO email
          field at all (`MeResponseSchema`) — only `account.displayName`, which
          is nullable. So a nameless account gets a greeting with no name rather
          than an invented one.
        */}
        <span className="block">{name === null ? "Chào bạn 👋" : `Chào ${name} 👋`}</span>
        <span className="block">Chào mừng tới MYSP</span>
      </h1>

      {/*
        48px tall, 12px corners, 0 24px of padding — measured (spec 2.4), and
        every one of them past what the local `Button` scale reaches, which tops
        out at 36px. `rounded-md` is the token nearest 12px (`--radius` * 0.8 =
        12.8px); a literal 12px would mean hardcoding a radius against the
        theme's own scale.

        It HUGS its label (~139px measured) instead of stretching: no `w-full`
        here, and the column above centres rather than stretches it.
      */}
      <Button
        type="button"
        onClick={onStart}
        style={BUTTON_DELAY}
        className="onboarding-late-in h-12 gap-2 rounded-md px-6 text-sm font-medium"
      >
        Bắt đầu
        <ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}
