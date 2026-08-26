"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";

import { isOnboardingScreen, type OnboardingScreen } from "./onboarding-steps";

/**
 * Which onboarding screens the operator has already walked past, for THIS
 * session — whether by answering them or by pressing "Bỏ qua".
 *
 * Deliberately `sessionStorage` and not the server: it is the ANSWERS that the
 * server keeps (`tenant_profile`), and a skipped question deliberately stores
 * nothing there. Without a local note, skipping would leave the flow resolving
 * back onto the very question it was just told to drop.
 *
 * `useSyncExternalStore`, in the same shape as `useSetupDockState`: web storage
 * IS an external store, the server has no answer for it, and a `setState` inside
 * an effect would paint the wrong screen first and then correct it — the flicker
 * this avoids. It is also what the repo's `react-hooks` rules require.
 *
 * Every access is wrapped: Safari in private mode THROWS on web storage rather
 * than returning null, and a flow that dies to remember a "Bỏ qua" is worse than
 * one that forgets it.
 */

const KEY_PREFIX = "mysp:onboarding:passed:";

/** Stable identity for "nothing yet" — `getSnapshot` is compared by identity. */
const EMPTY: readonly OnboardingScreen[] = [];

/**
 * Subscribers of THIS tab. No `storage` listener: `sessionStorage` is scoped to
 * one tab and only `markPassed` below ever writes it, so this hook is the only
 * thing that can change the answer.
 */
const listeners = new Set<() => void>();

/**
 * What this tab believes. It WINS over storage once it exists: the list only
 * ever grows, and a browser that refuses to persist must still let the operator
 * move forward. The note is lost on reload, which is acceptable; a "Bỏ qua"
 * button that does nothing is not.
 */
const inMemory = new Map<string, readonly OnboardingScreen[]>();

/**
 * Last raw string parsed per key and the array it produced. `getSnapshot` runs
 * on every render and React loops forever if a fresh array comes back each time.
 */
const snapshots = new Map<string, { raw: string | null; value: readonly OnboardingScreen[] }>();

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

function parsePassed(raw: string | null): readonly OnboardingScreen[] {
  if (!raw) return EMPTY;
  const parsed: unknown = JSON.parse(raw);
  // Unknown ids are dropped rather than trusted: a hand-edited value must not
  // decide which screen the flow opens on.
  return Array.isArray(parsed) ? parsed.filter(isOnboardingScreen) : EMPTY;
}

function readPassed(storageKey: string): readonly OnboardingScreen[] {
  const believed = inMemory.get(storageKey);
  if (believed) return believed;

  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch (error) {
    reportOnce("could not read passed screens", { storageKey, error });
    return EMPTY;
  }

  const cached = snapshots.get(storageKey);
  if (cached && cached.raw === raw) return cached.value;

  let value: readonly OnboardingScreen[];
  try {
    value = parsePassed(raw);
  } catch (error) {
    // A hand-edited value must not blank the screen: the flow simply starts
    // from the first unanswered question.
    reportOnce("could not parse passed screens", { storageKey, error, raw });
    value = EMPTY;
  }

  snapshots.set(storageKey, { raw, value });
  return value;
}

export function usePassedSlides(): {
  passed: readonly OnboardingScreen[];
  markPassed: (id: OnboardingScreen) => void;
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
    (id: OnboardingScreen) => {
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
        reportOnce("could not persist passed screens", { storageKey, error });
      }
      emit();
    },
    [storageKey],
  );

  return { passed, markPassed };
}
