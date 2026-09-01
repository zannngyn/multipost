"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Bung hay thu — remembered per company, on this machine.
 *
 * localStorage rather than a column: closing the dock is a preference of one
 * browser, not a fact about the company, and a mis-click must not follow the
 * operator to every device they own. It is also why the X collapses rather than
 * dismisses — nothing here is worth a migration to undo.
 *
 * `useSyncExternalStore` rather than useState + useEffect: localStorage IS an
 * external store, the server has no answer for it, and this is the hook that
 * models exactly that (a `setState` in an effect would render the wrong state
 * first and then correct it, which is the flicker this avoids). It also lets a
 * second tab of the same company follow along through the `storage` event.
 *
 * Every access is wrapped: Safari in private mode THROWS on `localStorage`
 * rather than returning null, and a dock that takes down the whole shell to
 * remember a preference is worse than one that forgets it.
 */

export type DockState = "expanded" | "collapsed";

const PREFIX = "mysp.setup-dock.";

/** Subscribers of THIS tab — `storage` only fires in the OTHER ones. */
const listeners = new Set<() => void>();

/**
 * What this tab believes, for the browser that refuses storage entirely.
 * Without it a refused write would leave `readState` answering the old value
 * and the dock frozen under the operator's hand — the preference is lost on
 * reload, which is acceptable; a control that does not respond is not.
 */
const inMemoryState = new Map<string, DockState>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Read failures are logged ONCE. `getSnapshot` runs on every render, so a
 * browser that refuses storage outright would otherwise fill the console with
 * the same line and bury everything else — the failure is still reported, just
 * not repeated (CLAUDE.md rule 5: never silent, never noise).
 */
let hasReportedReadFailure = false;

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * Must return a primitive: React compares snapshots by identity.
 *
 * Storage wins when it has an answer; the in-memory value covers both the
 * browser that refuses storage and the first paint after a write that failed.
 */
function readState(tenantKey: string): DockState {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${tenantKey}`);
    if (raw === "collapsed" || raw === "expanded") return raw;
  } catch (error) {
    if (!hasReportedReadFailure) {
      hasReportedReadFailure = true;
      console.warn("[setup-dock] could not read the stored dock state", { tenantKey, error });
    }
  }
  return inMemoryState.get(tenantKey) ?? "expanded";
}

export function useSetupDockState(tenantKey: string): {
  state: DockState;
  setState: (next: DockState) => void;
} {
  const state = useSyncExternalStore(
    subscribe,
    () => readState(tenantKey),
    // The server has no localStorage, so it renders the default and React
    // reconciles on hydration. Anything else would be a hydration mismatch.
    () => "expanded" as DockState,
  );

  const setState = useCallback(
    (next: DockState) => {
      // Believed FIRST, persisted second: this is what keeps the dock moving on
      // a browser that will not store anything.
      inMemoryState.set(tenantKey, next);
      try {
        window.localStorage.setItem(`${PREFIX}${tenantKey}`, next);
      } catch (error) {
        // Only the memory of the preference is lost; it is reported, not eaten.
        console.warn("[setup-dock] could not persist the dock state", { tenantKey, next, error });
      }
      emit();
    },
    [tenantKey],
  );

  return { state, setState };
}
