"use client";

import { useEffect, useState } from "react";

/**
 * Delays turning a flag on (core-feedback-states: show nothing under 300ms).
 * A fast response would otherwise flash a skeleton for one frame, which reads
 * as a glitch. Turning OFF is immediate — content must never wait.
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [elapsed, setElapsed] = useState(false);
  const [previousActive, setPreviousActive] = useState(active);

  // Adjusting state during render (the documented React alternative to an
  // effect): every new activation starts its own delay instead of reusing the
  // previous one, which would make the second load skip the delay entirely.
  if (previousActive !== active) {
    setPreviousActive(active);
    setElapsed(false);
  }

  useEffect(() => {
    if (!active) return;

    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return active && elapsed;
}
