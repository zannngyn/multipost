"use client";

import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";

/**
 * The link component every Astryx component routes through (`LinkProvider`).
 *
 * WHY IT EXISTS — the `to` leak. Astryx resolves a custom link component and
 * wraps it so it receives BOTH props (`@astryxdesign/core@0.4.0`
 * `dist/Link/useLinkComponent.js`: "wraps it to pass `to={href}` alongside
 * `href`"), because React Router and TanStack Router navigate by `to`. Next's
 * `<Link>` navigates by `href` and forwards anything it does not recognise
 * straight onto the anchor, so every nav row rendered as
 * `<a to="/posts" … href="/posts">` — a non-standard attribute on every link in
 * the app, invalid HTML that a strict validator flags and that says nothing to
 * anything.
 *
 * Swallowing `to` here is the one-line fix, at the one place the whole app
 * shares. `href` is untouched: it is what makes a nav row a real link —
 * focusable, middle-clickable, copyable, and understood as a link by a screen
 * reader — and `AppLink` must never be "improved" into an `onClick` handler.
 *
 * `ComponentPropsWithRef`: React 19 passes `ref` as an ordinary prop, so the
 * spread carries it to `NextLink` and Astryx's own refs still land on the
 * anchor.
 */
export function AppLink({ to: _to, ...props }: ComponentPropsWithRef<typeof NextLink> & { to?: string }) {
  return <NextLink {...props} />;
}
