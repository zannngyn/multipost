"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * Ticking "now", for countdowns computed against an ABSOLUTE instant
 * (web-booking-scheduling rule 2: never decrement a counter — a hidden tab
 * throttles timers and the number drifts by minutes; comparing with a deadline
 * cannot drift).
 *
 * `useSyncExternalStore`, not `useState` + `useEffect`: the clock is an
 * external system, the snapshot is read (not written) during render, and the
 * server snapshot is 0 so hydration cannot mismatch. Callers treat 0 as "chưa
 * biết giờ máy" and fall back to the value the server computed.
 */
export function useNowMs(intervalMs = 30_000): number {
  const clock = useMemo(() => createClock(intervalMs), [intervalMs]);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot);
}

interface Clock {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
  getServerSnapshot: () => number;
}

function createClock(intervalMs: number): Clock {
  // Cached on purpose: `getSnapshot` must return the SAME value until the store
  // actually changes, otherwise React re-renders forever.
  let snapshot = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    snapshot = Date.now();
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === null) {
        tick();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => snapshot,
    // No clock on the server: the markup must not carry a time the browser
    // would immediately disagree with.
    getServerSnapshot: () => 0,
  };
}
