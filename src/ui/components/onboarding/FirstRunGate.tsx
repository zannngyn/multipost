"use client";

import { useState, type ReactNode } from "react";

import { useActiveTenant } from "@/ui/hooks/useMe";

import { FirstRunWizard } from "./FirstRunWizard";

/**
 * Owns WHEN the first-run wizard is on screen — which is not the same question
 * as "is this account a member of nothing?".
 *
 * That distinction is the whole reason this component exists. Step 01 ends in
 * `useAdoptActiveTenant()`: the cache is dropped, `/api/me` is re-read, and the
 * account now HAS a company. Gate the dialog on `hasNoMembership` alone and it
 * unmounts the instant the company is created — the operator never sees step
 * 02, and the invite step may as well not have been built.
 *
 * So: `hasNoMembership` OPENS it, and only the operator CLOSES it. Once open it
 * stays open through the very state change that created the company.
 *
 * Closing is the transition into the app. There is no success screen: the
 * overview is already behind the dialog, already holding live data by then, and
 * the proof of having arrived is being inside (M2.1's original stance, kept).
 */
export function FirstRunGate({
  children,
  signOutAction,
}: {
  children: ReactNode;
  /** Server Action from the layout — `src/ui` may not import `src/app`. */
  signOutAction?: () => Promise<void>;
}) {
  const { hasNoMembership } = useActiveTenant();

  /**
   * Latched, not derived. Adjusted DURING render rather than in an effect: an
   * effect would paint one frame of the bare overview before the dialog
   * appeared, and that frame is the flash of an empty app this whole screen
   * exists to prevent.
   */
  const [hasOpened, setHasOpened] = useState(false);
  const [hasFinished, setHasFinished] = useState(false);

  if (hasNoMembership && !hasOpened) setHasOpened(true);

  const isOpen = hasOpened && !hasFinished;

  if (!isOpen) return <>{children}</>;

  return (
    <>
      {/*
        The overview keeps rendering behind the dialog.

        Before the company exists this costs NOTHING: `isResolved` is false, so
        every tenant-scoped hook stays disabled and the screen draws its own
        empty frame (spec §6). After step 01 it starts filling in for real,
        which is exactly what should be warming up while the operator reads
        step 02.

        `inert` rather than only a blur: a blurred pane is still tabbable, and a
        keyboard user would fall out of the dialog into controls that answer 409.
      */}
      <div aria-hidden="true" inert className="pointer-events-none blur-[3px] select-none">
        {children}
      </div>
      <FirstRunWizard onSignOut={signOutAction} onFinish={() => setHasFinished(true)} />
    </>
  );
}
