"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";

/**
 * Sends an account that belongs to no company to the onboarding flow.
 *
 * LATCHED, not derived — the same reason the dialog this replaces was latched.
 * Slide 01 ends in `useAdoptActiveTenant()`: the account now HAS a company and
 * `hasNoMembership` flips to false. Derive the redirect from that flag alone and
 * the operator is thrown out of the flow the instant they finish slide 01, which
 * is exactly the bug the old `hasOpened` latch existed to prevent. Here the
 * latch also stops a second `router.replace` firing on every later render.
 *
 * `replace`, not `push`: the empty overview behind is not worth a history entry,
 * and Back out of onboarding must not land on an app where every API answers
 * 409.
 *
 * In an effect rather than during render: navigating is a side effect, and React
 * refuses a router call made while rendering. One frame of the bare overview is
 * the cost, and it is cheap — with no active company `useActiveTenant().isResolved`
 * is false, so that frame is an empty shell, not a screen full of dead controls.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { hasNoMembership } = useActiveTenant();

  /**
   * The latch itself. A ref and not state on purpose: it is never read while
   * rendering — nothing on screen changes because of it — so holding it in
   * state would only buy a second render, and setting state inside an effect is
   * the cascading-render pattern `react-hooks/set-state-in-effect` rejects.
   */
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (!hasNoMembership || hasRedirected.current) return;
    hasRedirected.current = true;
    router.replace("/onboarding");
  }, [hasNoMembership, router]);

  /**
   * The app keeps rendering underneath while the navigation is in flight.
   *
   * Before the company exists this costs NOTHING: `isResolved` is false, so
   * every tenant-scoped hook stays disabled and each screen draws its own empty
   * frame (spec §6). Not one request goes out.
   */
  return <>{children}</>;
}
