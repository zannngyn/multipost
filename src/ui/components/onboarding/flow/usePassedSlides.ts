"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";

import { isOnboardingSlideId, type OnboardingSlideId } from "./onboarding-steps";

/**
 * Which slides the operator has already walked past, for THIS session.
 *
 * Deliberately `sessionStorage` and not the server: "Để sau" is a decision about
 * the next two minutes, not a fact about the tenant. What is genuinely unfinished
 * is already tracked by the six flags, and `SetupDock` keeps pointing at it long
 * after this flow closes.
 *
 * `useSyncExternalStore`, in the same shape as `useSetupDockState`: web storage
 * IS an external store, the server has no answer for it, and a `setState` inside
 * an effect would paint the wrong slide first and then correct it — the flicker
 * this avoids. It is also what the repo's `react-hooks` rules require.
 *
 * Every access is wrapped: Safari in private mode THROWS on web storage rather
 * than returning null, and a flow that dies to remember a "Để sau" is worse than
 * one that forgets it.
 */

const KEY_PREFIX = "mysp:onboarding:passed:";

/** Stable identity for "nothing yet" — `getSnapshot` is compared by identity. */
const EMPTY: readonly OnboardingSlideId[] = [];

/**
 * Subscribers of THIS tab. No `storage` listener: `sessionStorage` is scoped to
 * one tab and only `markPassed` below ever writes it, so this hook is the only
 * thing that can change the answer.
 */
const listeners = new Set<() => void>();

/**
 * What this tab believes. It WINS over storage once it exists: the list only
 * ever grows, and a browser that refuses to persist must still let the operator
 * move forward. The note is lost on reload, which is acceptable; a "Để sau"
 * button that does nothing is not.
 */
const inMemory = new Map<string, readonly OnboardingSlideId[]>();

/**
 * Last raw string parsed per key and the array it produced. `getSnapshot` runs
 * on every render and React loops forever if a fresh array comes back each time.
 */
const snapshots = new Map<string, { raw: string | null; value: readonly OnboardingSlideId[] }>();

/**
 * Failures are reported ONCE per kind. `getSnapshot` runs on every render, so a
 * browser that refuses storage outright would otherwise bury the console
 * (CLAUDE.md rule 5: never silent, never noise).
 */
const reported = new Set<string>();

function reportOnce(kind: string, context: Record<string, unknown>): void {
  if (reported.has(kind)) return;
  reported.add(kind);
  console.warn(`[onboarding] ${kind}`, context);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function parsePassed(raw: string | null): readonly OnboardingSlideId[] {
  if (!raw) return EMPTY;
  const parsed: unknown = JSON.parse(raw);
  // Unknown ids are dropped rather than trusted: a hand-edited value must not
  // decide which slide the flow opens on.
  return Array.isArray(parsed) ? parsed.filter(isOnboardingSlideId) : EMPTY;
}

function readPassed(storageKey: string): readonly OnboardingSlideId[] {
  const believed = inMemory.get(storageKey);
  if (believed) return believed;

  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch (error) {
    reportOnce("could not read passed slides", { storageKey, error });
    return EMPTY;
  }

  const cached = snapshots.get(storageKey);
  if (cached && cached.raw === raw) return cached.value;

  let value: readonly OnboardingSlideId[];
  try {
    value = parsePassed(raw);
  } catch (error) {
    // A hand-edited value must not blank the screen: the flow simply starts
    // from the first open slide.
    reportOnce("could not parse passed slides", { storageKey, error, raw });
    value = EMPTY;
  }

  snapshots.set(storageKey, { raw, value });
  return value;
}

export function usePassedSlides(): {
  passed: readonly OnboardingSlideId[];
  markPassed: (id: OnboardingSlideId) => void;
} {
  const { tenantKey } = useActiveTenant();
  const storageKey = `${KEY_PREFIX}${tenantKey}`;

  const passed = useSyncExternalStore(
    subscribe,
    () => readPassed(storageKey),
    // The server has no sessionStorage, so it renders "nothing passed yet" and
    // React reconciles on hydration. Anything else would be a mismatch.
    () => EMPTY,
  );

  const markPassed = useCallback(
    (id: OnboardingSlideId) => {
      const current = readPassed(storageKey);
      if (current.includes(id)) return;

      const updated = [...current, id];
      // Believed FIRST, persisted second — see `inMemory` above.
      inMemory.set(storageKey, updated);
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(updated));
      } catch (error) {
        // Storage full or blocked: the flow still advances in memory. Losing
        // the note across a reload is a smaller failure than a dead button.
        reportOnce("could not persist passed slides", { storageKey, error });
      }
      emit();
    },
    [storageKey],
  );

  return { passed, markPassed };
}
